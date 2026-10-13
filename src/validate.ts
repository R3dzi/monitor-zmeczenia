import { RULES } from './rules.config';
import type { DataFile, Measurement } from './types';

export const HR_COUNT = 10;
export const MAX_NOTES = 2000;
export const MAX_FILE_CHARS = 5_000_000;
export const MAX_RECORDS = 20_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidIso(s: unknown): s is string {
  return typeof s === 'string' && ISO_RE.test(s) && !Number.isNaN(Date.parse(s));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface Range {
  min: number;
  max: number;
}

function readNumber(v: unknown, range: Range, label: string, errors: string[]): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    errors.push(`${label}: wartość musi być liczbą albo null`);
    return null;
  }
  if (v < range.min || v > range.max) {
    errors.push(`${label}: ${v} jest poza zakresem ${range.min}–${range.max}`);
    return null;
  }
  return v;
}

/**
 * Waliduje i normalizuje pojedynczy rekord. Pola spoza schematu (np. „status”,
 * „color”, „passed” z zewnętrznego JSON) są ignorowane – nie są zaufane.
 */
export function parseMeasurement(
  raw: unknown,
  label = 'rekord',
): { value: Measurement | null; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { value: null, errors: [`${label}: oczekiwano obiektu`] };

  const date = raw.date;
  if (!isValidDate(date)) errors.push(`${label}: nieprawidłowa data (oczekiwano YYYY-MM-DD)`);
  const name = isValidDate(date) ? date : label;

  const hrv = readNumber(raw.hrv, RULES.limits.hrv, `${name}: hrv`, errors);
  const bodyBattery = readNumber(raw.bodyBattery, RULES.limits.bodyBattery, `${name}: bodyBattery`, errors);
  const ssz = readNumber(raw.ssz, RULES.limits.ssz, `${name}: ssz`, errors);

  let pace: number | null = null;
  let hr: (number | null)[] = Array.from({ length: HR_COUNT }, () => null);
  if (raw.morningRun !== undefined && raw.morningRun !== null) {
    if (!isPlainObject(raw.morningRun)) {
      errors.push(`${name}: morningRun musi być obiektem`);
    } else {
      pace = readNumber(raw.morningRun.pace, RULES.limits.pace, `${name}: morningRun.pace`, errors);
      const rawHr = raw.morningRun.hr;
      if (rawHr !== undefined && rawHr !== null) {
        if (!Array.isArray(rawHr) || rawHr.length !== HR_COUNT) {
          errors.push(`${name}: morningRun.hr musi zawierać dokładnie ${HR_COUNT} pomiarów`);
        } else {
          hr = rawHr.map((v, i) => readNumber(v, RULES.limits.hr, `${name}: morningRun.hr[${i}]`, errors));
        }
      }
    }
  }

  let notes: string | undefined;
  if (raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== 'string') errors.push(`${name}: notes musi być tekstem`);
    else if (raw.notes.length > MAX_NOTES) errors.push(`${name}: notes przekracza ${MAX_NOTES} znaków`);
    else if (raw.notes.trim() !== '') notes = raw.notes.trim();
  }

  if (!isValidIso(raw.modifiedAt)) errors.push(`${name}: modifiedAt musi być znacznikiem czasu ISO-8601`);

  if (errors.length > 0 || !isValidDate(date) || !isValidIso(raw.modifiedAt)) {
    return { value: null, errors };
  }
  const value: Measurement = {
    date,
    hrv,
    bodyBattery,
    ssz,
    morningRun: { pace, hr },
    modifiedAt: raw.modifiedAt,
  };
  if (notes !== undefined) value.notes = notes;
  return { value, errors };
}

export function parseMeasurementList(
  raw: unknown,
  label = 'measurements',
): { ok: true; records: Measurement[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(raw)) return { ok: false, errors: [`${label}: oczekiwano tablicy`] };
  if (raw.length > MAX_RECORDS) return { ok: false, errors: [`${label}: zbyt wiele rekordów (max ${MAX_RECORDS})`] };
  const errors: string[] = [];
  const records: Measurement[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const { value, errors: e } = parseMeasurement(item, `${label}[${i}]`);
    if (!value) {
      errors.push(...e);
      return;
    }
    if (seen.has(value.date)) {
      errors.push(`${label}: zduplikowana data ${value.date}`);
      return;
    }
    seen.add(value.date);
    records.push(value);
  });
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 10) };
  return { ok: true, records };
}

/** Parsuje i waliduje zawartość pliku data.json. Przy jakimkolwiek błędzie odrzuca cały plik. */
export function parseDataFile(
  text: string,
): { ok: true; data: DataFile } | { ok: false; errors: string[] } {
  if (typeof text !== 'string' || text.length > MAX_FILE_CHARS) {
    return { ok: false, errors: ['plik jest zbyt duży'] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['zawartość nie jest poprawnym JSON-em'] };
  }
  if (!isPlainObject(json)) return { ok: false, errors: ['oczekiwano obiektu JSON na najwyższym poziomie'] };
  if (json.schemaVersion !== 1) {
    const v = json.schemaVersion;
    return {
      ok: false,
      errors: [
        typeof v === 'number' && v > 1
          ? `plik pochodzi z nowszej wersji schematu (${v}) – zaktualizuj aplikację`
          : 'brak lub nieobsługiwana wartość schemaVersion (oczekiwano 1)',
      ],
    };
  }
  if (!isValidIso(json.updatedAt)) return { ok: false, errors: ['updatedAt musi być znacznikiem czasu ISO-8601'] };
  const list = parseMeasurementList(json.measurements);
  if (!list.ok) return list;
  return { ok: true, data: { schemaVersion: 1, updatedAt: json.updatedAt, measurements: list.records } };
}

export function serializeDataFile(records: Measurement[], now: Date): string {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const data: DataFile = { schemaVersion: 1, updatedAt: now.toISOString(), measurements: sorted.map(toPublic) };
  return JSON.stringify(data, null, 2) + '\n';
}

/** Zostawia tylko pola schematu (bez metadanych synchronizacji). */
export function toPublic(m: Measurement): Measurement {
  const out: Measurement = {
    date: m.date,
    hrv: m.hrv,
    bodyBattery: m.bodyBattery,
    ssz: m.ssz,
    morningRun: { pace: m.morningRun.pace, hr: [...m.morningRun.hr] },
    modifiedAt: m.modifiedAt,
  };
  if (m.notes) out.notes = m.notes;
  return out;
}
