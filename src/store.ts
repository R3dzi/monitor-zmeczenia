import type { FatigueDB } from './db';
import { ValidationError } from './errors';
import { canonical } from './merge';
import { DEFAULT_CONFIG, type LocalMeasurement, type Measurement, type RepoConfig } from './types';
import { parseMeasurement } from './validate';

export function localDateString(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tomorrowString(now: Date): string {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  return localDateString(t);
}

/**
 * Zapis lokalny – działa całkowicie offline i nie zależy od GitHuba.
 * Rekord oznaczany jest jako oczekujący na synchronizację (dirty = 1).
 */
export async function saveMeasurement(
  db: FatigueDB,
  input: Omit<Measurement, 'modifiedAt'>,
  now: Date = new Date(),
): Promise<{ record: LocalMeasurement; changed: boolean }> {
  const { value, errors } = parseMeasurement({ ...input, modifiedAt: now.toISOString() });
  if (!value) throw new ValidationError(errors);
  const extra: string[] = [];
  if (value.date > tomorrowString(now)) extra.push('Data nie może wypadać w przyszłości.');
  const hasValue =
    value.hrv !== null ||
    value.bodyBattery !== null ||
    value.ssz !== null ||
    value.morningRun.pace !== null ||
    value.morningRun.hr.some((v) => v !== null) ||
    !!value.notes;
  if (!hasValue) extra.push('Wpisz co najmniej jedną wartość.');
  if (extra.length) throw new ValidationError(extra);

  return db.transaction('rw', db.measurements, async () => {
    const existing = await db.measurements.get(value.date);
    if (existing && canonical(existing) === canonical(value)) {
      return { record: existing, changed: false };
    }
    const record: LocalMeasurement = { ...value, dirty: 1, syncedBase: existing?.syncedBase ?? null };
    await db.measurements.put(record);
    return { record, changed: true };
  });
}

export const getAllMeasurements = (db: FatigueDB) => db.measurements.orderBy('date').toArray();
export const countPending = (db: FatigueDB) => db.measurements.where('dirty').equals(1).count();

export async function getConfig(db: FatigueDB): Promise<RepoConfig> {
  const row = await db.meta.get('config');
  const v = (row?.value ?? {}) as Partial<RepoConfig>;
  return {
    owner: typeof v.owner === 'string' ? v.owner : DEFAULT_CONFIG.owner,
    repo: typeof v.repo === 'string' ? v.repo : DEFAULT_CONFIG.repo,
    path: typeof v.path === 'string' && v.path ? v.path : DEFAULT_CONFIG.path,
    branch: typeof v.branch === 'string' && v.branch ? v.branch : DEFAULT_CONFIG.branch,
  };
}

export const setConfig = (db: FatigueDB, cfg: RepoConfig) =>
  db.meta.put({ key: 'config', value: { ...cfg } });

export async function getLastSync(db: FatigueDB): Promise<string | null> {
  const row = await db.meta.get('lastSyncAt');
  return typeof row?.value === 'string' ? row.value : null;
}

export const setLastSync = (db: FatigueDB, iso: string) => db.meta.put({ key: 'lastSyncAt', value: iso });
