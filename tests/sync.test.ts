import { describe, expect, it } from 'vitest';
import { GitHubError, SyncError } from '../src/errors';
import { MemoryTokenAuth } from '../src/github/auth';
import { canonical } from '../src/merge';
import { getConfig, getLastSync, setConfig } from '../src/store';
import { OperationLock } from '../src/sync/lock';
import { executePlan, preparePlan, summarize } from '../src/sync/syncService';
import { parseDataFile } from '../src/validate';
import { CONFIG, FakeGitHub, TOKEN, makeCtx, rec, remoteFile, saveLocal } from './helpers';

async function fullSync(ctx: ReturnType<typeof makeCtx>['ctx'], mode: 'sync' | 'pull' | 'push' = 'sync', res = {}) {
  const plan = await preparePlan(ctx, mode);
  return executePlan(ctx, plan, res);
}

describe('GitHub Contents API', () => {
  it('tworzy plik JSON przy pierwszej synchronizacji (PUT bez sha) w poprawnym schemacie', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-02'));
    await saveLocal(db, rec('2026-10-01', { hrv: 55 }));

    const result = await fullSync(ctx);
    expect(result.status).toBe('done');

    const put = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put.hasSha).toBe(false);
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.schemaVersion).toBe(1);
      expect(parsed.data.updatedAt).toBe('2026-10-13T10:00:00.000Z');
      expect(parsed.data.measurements.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02']);
      expect(JSON.stringify(parsed.data)).not.toMatch(/dirty|syncedBase/);
    }
    // po potwierdzeniu przez serwer rekordy są zsynchronizowane
    const rows = await db.measurements.toArray();
    expect(rows.every((r) => r.dirty === 0 && r.syncedBase === canonical(r))).toBe(true);
    expect(await getLastSync(db)).toBe('2026-10-13T10:00:00.000Z');
  });

  it('aktualizuje istniejący plik, przekazując aktualne sha', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01')]));
    const shaBefore = fake.getSha()!;
    await saveLocal(db, rec('2026-10-02'));

    expect((await fullSync(ctx)).status).toBe('done');
    const put = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put.hasSha).toBe(true);
    expect(fake.getSha()).not.toBe(shaBefore);
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02']);
    // dane zdalne dociągnięte lokalnie
    expect(await db.measurements.count()).toBe(2);
  });

  it('zawsze czyta aktualną wersję pliku przed zapisem (GET poprzedza PUT)', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    await fullSync(ctx);
    const methods = fake.requests.map((r) => r.method);
    expect(methods.indexOf('GET')).toBeLessThan(methods.indexOf('PUT'));
  });

  it('obsługuje nieprawidłowy token (401) bez zmiany danych lokalnych i bez ujawnienia tokenu', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    fake.validToken = 'inny-token-xxxxxxxxxxxxxxxxxxxxxxxx';

    const err = await preparePlan(ctx, 'sync').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('auth');
    expect(String(err.message)).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect((await db.measurements.get('2026-10-01'))?.dirty).toBe(1);
  });

  it('obsługuje błąd sieci i zachowuje dane lokalne jako oczekujące', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    fake.networkDown = true;
    const err = await preparePlan(ctx, 'sync').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain(TOKEN);
    expect((await db.measurements.get('2026-10-01'))?.dirty).toBe(1);
  });

  it('mapuje 403 (brak uprawnień), limit zapytań i 5xx na konkretne błędy', async () => {
    const { db, auth } = makeCtx();
    const mk = (status: number, headers: Record<string, string> = {}, message = 'x') =>
      makeCtx({ db, auth, fake: Object.assign(new FakeGitHub(), {}) });
    void mk;
    const { GitHubClient } = await import('../src/github/client');
    const respond = (status: number, headers: Record<string, string> = {}, message = 'msg') =>
      new GitHubClient(auth, async () => new Response(JSON.stringify({ message }), { status, headers }));
    await expect(respond(403).getFile(CONFIG)).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(respond(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }).getFile(CONFIG)).rejects.toMatchObject({ kind: 'ratelimit' });
    await expect(respond(429).getFile(CONFIG)).rejects.toMatchObject({ kind: 'ratelimit' });
    await expect(respond(503).getFile(CONFIG)).rejects.toMatchObject({ kind: 'server' });
    await expect(respond(422, {}, 'Invalid request').getFile(CONFIG)).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('konflikt wersji pliku (sha)', () => {
  it('po 409 ponownie pobiera plik, scala od początku i nie gubi zmian z obu stron', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01')]));
    await saveLocal(db, rec('2026-10-03'));

    const plan = await preparePlan(ctx, 'sync');
    // Inne urządzenie dopisuje rekord między odczytem a zapisem.
    fake.beforePut = () => {
      fake.beforePut = null;
      fake.setFile(remoteFile([rec('2026-10-01'), rec('2026-10-02', { hrv: 77 })]));
    };

    const result = await executePlan(ctx, plan, {});
    expect(result.status).toBe('done');
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(2); // pierwszy odrzucony (409), drugi po ponownym scaleniu
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect((await db.measurements.get('2026-10-02'))?.hrv).toBe(77);
    expect((await db.measurements.get('2026-10-03'))?.dirty).toBe(0);
  });

  it('po wyczerpaniu prób zgłasza błąd, a lokalne zmiany pozostają oczekujące', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01')]));
    await saveLocal(db, rec('2026-10-03'));
    fake.beforePut = () => fake.setFile(remoteFile([rec('2026-10-01')])); // za każdym razem nowe sha
    const err = await fullSync(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.kind).toBe('too-many-retries');
    expect((await db.measurements.get('2026-10-03'))?.dirty).toBe(1);
  });
});

describe('scalanie', () => {
  it('łączy rekordy z różnych dat po obu stronach', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01'), rec('2026-10-02')]));
    await saveLocal(db, rec('2026-10-03'));
    await saveLocal(db, rec('2026-10-04'));

    const plan = await preparePlan(ctx, 'sync');
    expect(plan.merge.addToLocal.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(plan.merge.addToRemote.map((m) => m.date)).toEqual(['2026-10-03', '2026-10-04']);
    expect(plan.merge.conflicts).toHaveLength(0);

    await executePlan(ctx, plan);
    expect((await db.measurements.toArray()).map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements).toHaveLength(4);
  });

  it('identyczny rekord po obu stronach zostaje bez zmian (bez zbędnego zapisu)', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01')]));
    await saveLocal(db, rec('2026-10-01'));
    const shaBefore = fake.getSha();
    const result = await fullSync(ctx);
    expect(result.status).toBe('done');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(fake.getSha()).toBe(shaBefore);
    expect((await db.measurements.get('2026-10-01'))?.dirty).toBe(0);
  });

  it('zmiana tylko po jednej stronie: lokalna lub zdalna wersja wygrywa na podstawie stanu ostatniej synchronizacji', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01'), rec('2026-10-02')]));
    await fullSync(ctx); // oba rekordy zsynchronizowane
    // lokalnie zmieniamy 10-01, zdalnie 10-02
    await saveLocal(db, rec('2026-10-01', { hrv: 44 }), new Date('2026-10-11T08:00:00.000Z'));
    fake.setFile(remoteFile([rec('2026-10-01'), rec('2026-10-02', { bodyBattery: 33 })]));

    const plan = await preparePlan(ctx, 'sync');
    expect(plan.merge.conflicts).toHaveLength(0);
    expect(plan.merge.updateRemote.map((u) => u.date)).toEqual(['2026-10-01']);
    expect(plan.merge.updateLocal.map((u) => u.date)).toEqual(['2026-10-02']);
    await executePlan(ctx, plan);

    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements.find((m) => m.date === '2026-10-01')?.hrv).toBe(44);
    expect((await db.measurements.get('2026-10-02'))?.bodyBattery).toBe(33);
  });

  it('konflikt tego samego dnia wymaga decyzji; nie działa „ostatni zapis wygrywa”', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01', { hrv: 80, modifiedAt: '2026-10-12T00:00:00.000Z' })]));
    await saveLocal(db, rec('2026-10-01', { hrv: 40 })); // lokalna jest „starsza”, ale niezależna

    const plan = await preparePlan(ctx, 'sync');
    expect(plan.merge.conflicts.map((c) => c.date)).toEqual(['2026-10-01']);

    const blocked = await executePlan(ctx, plan, {});
    expect(blocked.status).toBe('needs-resolution');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
    expect((await db.measurements.get('2026-10-01'))?.hrv).toBe(40);
    expect(summarize(plan, {}).conflictsLeft).toBe(1);

    // wybór wersji lokalnej → GitHub dostaje lokalną
    const done = await executePlan(ctx, plan, { '2026-10-01': 'local' });
    expect(done.status).toBe('done');
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements[0].hrv).toBe(40);
  });

  it('konflikt rozstrzygnięty na korzyść wersji z GitHuba zastępuje wersję lokalną', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01', { hrv: 80 })]));
    await saveLocal(db, rec('2026-10-01', { hrv: 40 }));
    const plan = await preparePlan(ctx, 'sync');
    await executePlan(ctx, plan, { '2026-10-01': 'remote' });
    const row = await db.measurements.get('2026-10-01');
    expect(row?.hrv).toBe(80);
    expect(row?.dirty).toBe(0);
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('tryb „pobierz” nie zapisuje na GitHubie, a tryb „wyślij” nie zmienia lokalnych danych', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([rec('2026-10-01')]));
    await saveLocal(db, rec('2026-10-02'));

    await fullSync(ctx, 'pull');
    expect(fake.requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(await db.measurements.count()).toBe(2);
    expect((await db.measurements.get('2026-10-02'))?.dirty).toBe(1);

    const other = makeCtx({ fake });
    fake.setFile(remoteFile([rec('2026-10-05')]));
    await saveLocal(other.db, rec('2026-10-06'));
    await fullSync(other.ctx, 'push');
    expect(await other.db.measurements.count()).toBe(1); // nic nie dociągnięto
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements.map((m) => m.date)).toEqual(['2026-10-05', '2026-10-06']);
  });
});

describe('ochrona przed utratą danych', () => {
  it('nieudany zapis (500) nie usuwa ani nie oznacza jako zsynchronizowanych danych lokalnych', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    fake.setFile(remoteFile([rec('2026-10-02')]));
    fake.failNextPut = 500;

    const err = await fullSync(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('server');
    const row = await db.measurements.get('2026-10-01');
    expect(row?.dirty).toBe(1);
    expect(row?.syncedBase).toBeNull();
    expect(await db.measurements.count()).toBe(1); // zmiany z GitHuba nie zostały częściowo zastosowane
    expect(await getLastSync(db)).toBeNull();

    // kolejna próba kończy się sukcesem i nic nie zostało zdublowane
    expect((await fullSync(ctx)).status).toBe('done');
    expect(await db.measurements.count()).toBe(2);
  });

  it('uszkodzony plik na GitHubie jest odrzucany bez zmian lokalnych i bez nadpisania pliku', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    for (const bad of ['{nie json', '', JSON.stringify({ schemaVersion: 1, updatedAt: 'x', measurements: [] }), JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-01T00:00:00Z', measurements: [{ date: '2026-02-31' }] })]) {
      fake.setFile(bad);
      const err = await preparePlan(ctx, 'sync').catch((e) => e);
      expect(err).toBeInstanceOf(SyncError);
      expect(err.kind).toBe('invalid-remote');
      expect(fake.getText()).toBe(bad);
    }
    expect((await db.measurements.get('2026-10-01'))?.dirty).toBe(1);
  });

  it('pusty plik/brak pliku na GitHubie nigdy nie zastępuje danych lokalnych', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    await fullSync(ctx, 'pull'); // brak pliku
    fake.setFile(remoteFile([]));
    await fullSync(ctx, 'pull'); // pusta lista rekordów
    expect(await db.measurements.count()).toBe(1);
    await fullSync(ctx, 'sync');
    const parsed = parseDataFile(fake.getText()!);
    expect(parsed.ok && parsed.data.measurements).toHaveLength(1);
  });

  it('zmiana lokalna wykonana w trakcie synchronizacji pozostaje oczekująca', async () => {
    const { fake, db, ctx } = makeCtx();
    fake.setFile(remoteFile([]));
    await saveLocal(db, rec('2026-10-01'));
    const plan = await preparePlan(ctx, 'sync');
    fake.beforePut = () => {
      fake.beforePut = null;
      // użytkownik edytuje rekord, gdy zapis jest w toku
      void saveLocal(db, rec('2026-10-01', { hrv: 99 }), new Date('2026-10-11T08:00:00.000Z'));
    };
    await executePlan(ctx, plan);
    await new Promise((r) => setTimeout(r, 50));
    const row = await db.measurements.get('2026-10-01');
    expect(row?.hrv).toBe(99);
    expect(row?.dirty).toBe(1);
  });

  it('blokada uniemożliwia równoległe uruchomienie tej samej operacji', async () => {
    const lock = new OperationLock();
    let release!: () => void;
    const first = lock.run(() => new Promise<void>((r) => (release = r)));
    await expect(lock.run(async () => 1)).rejects.toMatchObject({ kind: 'busy' });
    release();
    await first;
    await expect(lock.run(async () => 2)).resolves.toBe(2);
  });
});

describe('ponowne połączenie po odświeżeniu strony', () => {
  it('po „odświeżeniu” token znika, konfiguracja zostaje, a ponowne wklejenie tokenu przywraca synchronizację bez duplikatów', async () => {
    const first = makeCtx();
    await setConfig(first.db, CONFIG);
    await saveLocal(first.db, rec('2026-10-01'));
    await fullSync(first.ctx);

    // „reload”: nowy obiekt auth (pamięć wyczyszczona), ta sama baza IndexedDB i ten sam „GitHub”
    const afterReload = makeCtx({ db: first.db, fake: first.fake, auth: new MemoryTokenAuth() });
    expect(afterReload.auth.isAuthenticated()).toBe(false);
    const err = await preparePlan(afterReload.ctx, 'sync').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect(err.kind).toBe('no-token');

    expect(await getConfig(first.db)).toMatchObject({ owner: CONFIG.owner, repo: CONFIG.repo, path: 'data.json', branch: 'main' });
    expect(await first.db.measurements.count()).toBe(1);

    afterReload.auth.setToken(TOKEN);
    await saveLocal(first.db, rec('2026-10-02'));
    expect((await fullSync(afterReload.ctx)).status).toBe('done');
    const parsed = parseDataFile(first.fake.getText()!);
    expect(parsed.ok && parsed.data.measurements.map((m) => m.date)).toEqual(['2026-10-01', '2026-10-02']);
  });
});
