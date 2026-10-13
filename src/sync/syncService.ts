import type { FatigueDB } from '../db';
import { GitHubError, SyncError } from '../errors';
import type { GitHubClient } from '../github/client';
import {
  buildRemoteRecords,
  canonical,
  effectiveOps,
  planMerge,
  type MergePlan,
  type Resolution,
  type SyncMode,
} from '../merge';
import { setLastSync } from '../store';
import type { Measurement, RepoConfig } from '../types';
import { parseDataFile, serializeDataFile } from '../validate';

export interface SyncContext {
  db: FatigueDB;
  client: GitHubClient;
  config: RepoConfig;
  now?: () => Date;
  maxAttempts?: number;
}

export interface RemoteSnapshot {
  exists: boolean;
  sha?: string;
  records: Measurement[];
}

export interface SyncPlan {
  mode: SyncMode;
  remote: RemoteSnapshot;
  merge: MergePlan;
}

export interface SyncSummary {
  pulledNew: number;
  pulledUpdated: number;
  pushedNew: number;
  pushedUpdated: number;
  identical: number;
  conflictsLeft: number;
  wroteRemote: boolean;
}

export type ExecuteResult =
  | { status: 'done'; summary: SyncSummary }
  | { status: 'needs-resolution'; plan: SyncPlan };

const nowOf = (ctx: SyncContext) => (ctx.now ?? (() => new Date()))();

/** Pobiera i waliduje plik z GitHuba. Uszkodzony plik jest odrzucany, nic nie jest zapisywane. */
export async function fetchRemote(ctx: SyncContext): Promise<RemoteSnapshot> {
  const file = await ctx.client.getFile(ctx.config);
  if (!file.exists) return { exists: false, records: [] };
  const parsed = parseDataFile(file.text);
  if (!parsed.ok) {
    throw new SyncError(
      'invalid-remote',
      `Plik na GitHubie jest uszkodzony lub ma nieprawidłowy format (${parsed.errors.slice(0, 3).join('; ')}). ` +
        'Nic nie zostało zmienione – ani lokalnie, ani na GitHubie.',
    );
  }
  return { exists: true, sha: file.sha, records: parsed.data.measurements };
}

/** Etap 1: tylko odczyt. Pobiera plik i lokalne rekordy oraz buduje plan scalania (bez żadnych zapisów). */
export async function preparePlan(ctx: SyncContext, mode: SyncMode): Promise<SyncPlan> {
  const remote = await fetchRemote(ctx);
  const local = await ctx.db.measurements.toArray();
  return { mode, remote, merge: planMerge(local, remote.records) };
}

/** Podsumowanie dla użytkownika (używane w oknie potwierdzenia i po wykonaniu). */
export function summarize(plan: SyncPlan, resolutions: Record<string, Resolution>): SyncSummary {
  const ops = effectiveOps(plan.merge, resolutions, plan.mode);
  const pulledNew = ops.toLocal.filter((o) => o.expectLocal === null).length;
  const pushedNew = ops.toRemote.filter((r) => plan.merge.addToRemote.some((a) => a.date === r.date)).length;
  return {
    pulledNew,
    pulledUpdated: ops.toLocal.length - pulledNew,
    pushedNew,
    pushedUpdated: ops.toRemote.length - pushedNew,
    identical: plan.merge.identical.length,
    conflictsLeft: plan.merge.conflicts.filter((c) => !resolutions[c.date]).length,
    wroteRemote: ops.toRemote.length > 0,
  };
}

function carryResolutions(
  prev: SyncPlan,
  next: SyncPlan,
  resolutions: Record<string, Resolution>,
): Record<string, Resolution> {
  const out: Record<string, Resolution> = {};
  for (const c of next.merge.conflicts) {
    const old = prev.merge.conflicts.find((p) => p.date === c.date);
    const choice = resolutions[c.date];
    // Wybór użytkownika zachowujemy tylko, gdy obie wersje są dokładnie te, które widział.
    if (old && choice && canonical(old.local) === canonical(c.local) && canonical(old.remote) === canonical(c.remote)) {
      out[c.date] = choice;
    }
  }
  return out;
}

/**
 * Etap 2: wykonanie planu. Kolejność gwarantuje brak utraty danych:
 *  1) zapis na GitHubie (jeśli potrzebny) z aktualnym sha,
 *  2) dopiero po potwierdzeniu przez serwer – zmiany lokalne i oznaczenie rekordów jako zsynchronizowane.
 * Przy konflikcie sha plik jest pobierany ponownie i scalanie zaczyna się od początku.
 * Lokalne dane nigdy nie są usuwane.
 */
export async function executePlan(
  ctx: SyncContext,
  plan: SyncPlan,
  resolutions: Record<string, Resolution> = {},
): Promise<ExecuteResult> {
  const maxAttempts = ctx.maxAttempts ?? 3;
  let current = plan;
  let res = resolutions;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (current.merge.conflicts.some((c) => !res[c.date])) {
      return { status: 'needs-resolution', plan: current };
    }
    const ops = effectiveOps(current.merge, res, current.mode);
    let finalRemote: Measurement[] = current.remote.records;

    if (ops.toRemote.length > 0) {
      finalRemote = buildRemoteRecords(current.remote.records, ops.toRemote);
      const text = serializeDataFile(finalRemote, nowOf(ctx));
      try {
        await ctx.client.putFile(
          ctx.config,
          text,
          current.remote.exists ? current.remote.sha : undefined,
          `Monitor zmęczenia: synchronizacja (${ops.toRemote.length} rek.)`,
        );
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'conflict') {
          if (attempt >= maxAttempts) {
            throw new SyncError(
              'too-many-retries',
              'Plik na GitHubie zmieniał się podczas synchronizacji. Dane lokalne są bezpieczne – spróbuj ponownie.',
            );
          }
          const fresh = await preparePlan(ctx, current.mode);
          res = carryResolutions(current, fresh, res);
          current = fresh;
          continue;
        }
        throw e; // dane lokalne pozostają nietknięte i oznaczone jako oczekujące
      }
    }

    await applyLocal(ctx, current, ops, finalRemote);
    return { status: 'done', summary: summarize(current, res) };
  }
  throw new SyncError('too-many-retries', 'Nie udało się zakończyć synchronizacji. Dane lokalne są bezpieczne.');
}

async function applyLocal(
  ctx: SyncContext,
  plan: SyncPlan,
  ops: ReturnType<typeof effectiveOps>,
  finalRemote: Measurement[],
): Promise<void> {
  const { db } = ctx;
  const remoteByDate = new Map(finalRemote.map((r) => [r.date, r]));

  await db.transaction('rw', db.measurements, db.meta, async () => {
    // 1) Zmiany z GitHuba → lokalnie (tylko jeśli lokalny rekord nie zmienił się w trakcie operacji).
    for (const op of ops.toLocal) {
      const cur = await db.measurements.get(op.record.date);
      if (op.expectLocal === null ? cur !== undefined : !cur || canonical(cur) !== op.expectLocal) continue;
      await db.measurements.put({ ...op.record, dirty: 0, syncedBase: canonical(op.record) });
    }

    // 2) Rekordy, które po operacji są takie same lokalnie i na GitHubie → zsynchronizowane.
    const equalDates = new Set<string>([...plan.merge.identical, ...ops.toRemote.map((r) => r.date)]);
    for (const date of equalDates) {
      const cur = await db.measurements.get(date);
      const rem = remoteByDate.get(date);
      if (!cur || !rem) continue;
      const base = canonical(rem);
      if (canonical(cur) === base) {
        await db.measurements.put({ ...cur, dirty: 0, syncedBase: base });
      } else {
        // Użytkownik zmienił rekord w trakcie synchronizacji: zmiana zostaje oczekująca.
        await db.measurements.put({ ...cur, dirty: 1, syncedBase: base });
      }
    }

    await setLastSync(db, nowOf(ctx).toISOString());
  });
}
