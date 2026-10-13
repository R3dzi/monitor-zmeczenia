import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { API_BASE, GitHubClient, validateRepoConfig } from '../src/github/client';
import { MemoryTokenAuth } from '../src/github/auth';
import { setConfig } from '../src/store';
import { executePlan, preparePlan } from '../src/sync/syncService';
import { CONFIG, TOKEN, makeCtx, rec, saveLocal } from './helpers';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('token nie jest nigdzie zapisywany', () => {
  it('po połączeniu i synchronizacji nie ma go w localStorage, sessionStorage ani w żadnej bazie IndexedDB', async () => {
    const { fake, db, ctx, auth } = makeCtx();
    await setConfig(db, CONFIG);
    await saveLocal(db, rec('2026-10-01'));
    await client_info(ctx.client);
    await executePlan(ctx, await preparePlan(ctx, 'sync'));
    expect(auth.isAuthenticated()).toBe(true);
    expect(fake.getText()).toBeDefined();

    const dump: string[] = [];
    for (let i = 0; i < localStorage.length; i++) dump.push(localStorage.key(i)!, localStorage.getItem(localStorage.key(i)!)!);
    for (let i = 0; i < sessionStorage.length; i++) dump.push(sessionStorage.key(i)!, sessionStorage.getItem(sessionStorage.key(i)!)!);

    const names = (await indexedDB.databases()).map((d) => d.name!).filter(Boolean);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const raw = new Dexie(name);
      await raw.open();
      for (const table of raw.tables) dump.push(JSON.stringify(await table.toArray()));
      raw.close();
    }
    const everything = dump.join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toMatch(/ghp_|github_pat_|Bearer/);
    // token nie trafia też do pliku JSON na GitHubie
    expect(fake.getText()).not.toContain(TOKEN);
  });

  it('obiekt auth nie ujawnia tokenu przy serializacji', () => {
    const auth = new MemoryTokenAuth();
    auth.setToken(TOKEN);
    expect(JSON.stringify(auth)).not.toContain(TOKEN);
    expect(String(auth)).not.toContain(TOKEN);
    expect(JSON.stringify(Object.entries(auth))).not.toContain(TOKEN);
    auth.clear();
    expect(auth.getAuthorizationHeader()).toBeNull();
  });

  it('odrzuca tokeny z niedozwolonymi znakami (ochrona nagłówka)', () => {
    const auth = new MemoryTokenAuth();
    expect(() => auth.setToken('')).toThrow();
    expect(() => auth.setToken('a'.repeat(25) + '\r\nX-Evil: 1')).toThrow();
  });
});

describe('token trafia wyłącznie do api.github.com', () => {
  it('wszystkie żądania mają host api.github.com, a konfiguracja nie pozwala zmienić adresu', async () => {
    const { fake, db, ctx } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    await executePlan(ctx, await preparePlan(ctx, 'sync'));
    expect(fake.requests.length).toBeGreaterThan(0);
    expect(new Set(fake.requests.map((r) => r.host))).toEqual(new Set(['api.github.com']));
    expect(API_BASE).toBe('https://api.github.com');

    expect(validateRepoConfig({ ...CONFIG, owner: 'evil.com/../x' })).not.toHaveLength(0);
    expect(validateRepoConfig({ ...CONFIG, repo: 'a/b' })).not.toHaveLength(0);
    expect(validateRepoConfig({ ...CONFIG, path: '../etc/passwd' })).not.toHaveLength(0);
    expect(validateRepoConfig({ ...CONFIG, path: '/abs' })).not.toHaveLength(0);
    expect(validateRepoConfig({ ...CONFIG, path: 'dane/data.json' })).toHaveLength(0);
  });

  it('żądania nie wysyłają ciasteczek ani referrera', async () => {
    const auth = new MemoryTokenAuth();
    auth.setToken(TOKEN);
    const seen: RequestInit[] = [];
    const client = new GitHubClient(auth, async (_u, init) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ private: true, permissions: { push: true } }), { status: 200 });
    });
    await client.getRepo('jan', 'dane');
    expect(seen[0].credentials).toBe('omit');
    expect(seen[0].referrerPolicy).toBe('no-referrer');
    expect(seen[0].cache).toBe('no-store');
  });
});

describe('statyczna kontrola kodu źródłowego', () => {
  it('moduły GitHub/sync/auth nie używają localStorage, sessionStorage, Cache Storage ani console', () => {
    const files = [...walk('src/github'), ...walk('src/sync'), 'src/store.ts', 'src/db.ts', 'src/ui/session.ts', 'src/ui/useGitHub.ts'];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/localStorage|sessionStorage|caches\.|console\./);
    }
  });

  it('żaden plik źródłowy nie zawiera zakodowanego tokenu ani sekretów', () => {
    for (const f of walk('src')) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|client_secret|BEGIN (RSA )?PRIVATE KEY/);
    }
  });

  it('service worker nie przechwytuje żądań cross-origin i nie zna api.github.com', () => {
    const sw = readFileSync('public/sw.js', 'utf8');
    expect(sw).toContain('url.origin !== self.location.origin');
    expect(sw).not.toContain('api.github.com');
  });
});

async function client_info(client: GitHubClient) {
  const info = await client.getRepo(CONFIG.owner, CONFIG.repo);
  expect(info).toEqual({ isPrivate: true, canPush: true });
}
