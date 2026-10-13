import type { LocalMeasurement, Measurement } from './types';
import { toPublic } from './validate';

export type SyncMode = 'sync' | 'pull' | 'push';
export type Resolution = 'local' | 'remote';

/** Postać kanoniczna zawartości rekordu (bez modifiedAt i metadanych synchronizacji). */
export function canonical(m: Measurement): string {
  return JSON.stringify([
    m.date,
    m.hrv,
    m.bodyBattery,
    m.ssz,
    m.morningRun.pace,
    ...m.morningRun.hr,
    m.notes ?? '',
  ]);
}

export interface Conflict {
  date: string;
  local: Measurement;
  remote: Measurement;
}

export interface MergePlan {
  /** Rekordy tylko na GitHubie → dodać lokalnie. */
  addToLocal: Measurement[];
  /** Zmienione tylko na GitHubie → zastąpić lokalny. */
  updateLocal: { date: string; local: Measurement; remote: Measurement }[];
  /** Rekordy tylko lokalnie → dodać na GitHubie. */
  addToRemote: Measurement[];
  /** Zmienione tylko lokalnie → zastąpić rekord na GitHubie. */
  updateRemote: { date: string; local: Measurement; remote: Measurement }[];
  /** Identyczne po obu stronach. */
  identical: string[];
  /** Zmienione niezależnie po obu stronach (albo nie da się ustalić, która zmiana jest nowa). */
  conflicts: Conflict[];
}

/**
 * Trójstronne scalanie po dacie. „Bazą” jest zawartość rekordu zapisana przy
 * ostatniej udanej synchronizacji (`syncedBase`). Reguła „ostatni zapis wygrywa”
 * NIE jest stosowana: gdy obie strony różnią się od bazy (albo bazy nie ma),
 * powstaje konflikt do rozstrzygnięcia przez użytkownika.
 * Scalanie nigdy nie usuwa rekordów.
 */
export function planMerge(local: LocalMeasurement[], remote: Measurement[]): MergePlan {
  const plan: MergePlan = {
    addToLocal: [],
    updateLocal: [],
    addToRemote: [],
    updateRemote: [],
    identical: [],
    conflicts: [],
  };
  const lmap = new Map(local.map((l) => [l.date, l]));
  const rmap = new Map(remote.map((r) => [r.date, r]));
  const dates = [...new Set([...lmap.keys(), ...rmap.keys()])].sort();

  for (const date of dates) {
    const l = lmap.get(date);
    const r = rmap.get(date);
    if (l && !r) {
      plan.addToRemote.push(toPublic(l));
    } else if (!l && r) {
      plan.addToLocal.push(r);
    } else if (l && r) {
      const cl = canonical(l);
      const cr = canonical(r);
      if (cl === cr) {
        plan.identical.push(date);
      } else if (l.syncedBase !== null && cl === l.syncedBase) {
        plan.updateLocal.push({ date, local: toPublic(l), remote: r });
      } else if (l.syncedBase !== null && cr === l.syncedBase) {
        plan.updateRemote.push({ date, local: toPublic(l), remote: r });
      } else {
        plan.conflicts.push({ date, local: toPublic(l), remote: r });
      }
    }
  }
  return plan;
}

export interface LocalOp {
  /** Oczekiwana zawartość lokalna (null = rekordu lokalnie nie powinno być). */
  expectLocal: string | null;
  record: Measurement;
}

export interface EffectiveOps {
  toLocal: LocalOp[];
  toRemote: Measurement[];
}

/** Przekłada plan i wybory użytkownika na konkretne operacje, z uwzględnieniem trybu. */
export function effectiveOps(
  plan: MergePlan,
  resolutions: Record<string, Resolution>,
  mode: SyncMode,
): EffectiveOps {
  const toLocal: LocalOp[] = [
    ...plan.addToLocal.map((record) => ({ expectLocal: null, record })),
    ...plan.updateLocal.map((u) => ({ expectLocal: canonical(u.local), record: u.remote })),
  ];
  const toRemote: Measurement[] = [...plan.addToRemote, ...plan.updateRemote.map((u) => u.local)];
  for (const c of plan.conflicts) {
    const r = resolutions[c.date];
    if (r === 'remote') toLocal.push({ expectLocal: canonical(c.local), record: c.remote });
    else if (r === 'local') toRemote.push(c.local);
  }
  return {
    toLocal: mode === 'push' ? [] : toLocal,
    toRemote: mode === 'pull' ? [] : toRemote,
  };
}

/** Zawartość pliku na GitHubie po zapisie: aktualne rekordy zdalne + zmiany z toRemote. */
export function buildRemoteRecords(remote: Measurement[], toRemote: Measurement[]): Measurement[] {
  const map = new Map(remote.map((r) => [r.date, r]));
  for (const r of toRemote) map.set(r.date, r);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
