import type { FatigueDB } from './db';
import { evaluate } from './evaluate';
import { canonical } from './merge';
import type { LocalMeasurement, Measurement } from './types';
import {
  HR_COUNT,
  MAX_FILE_CHARS,
  parseDataFile,
  parseMeasurementList,
  serializeDataFile,
  toPublic,
} from './validate';

/* ------------------------------ Eksport ------------------------------ */

export function exportJson(records: Measurement[], now = new Date()): string {
  return serializeDataFile(records, now);
}

const CSV_HEADER = [
  'date',
  'hrv',
  'bodyBattery',
  'ssz',
  'morningRunPace',
  ...Array.from({ length: HR_COUNT }, (_, i) => `hr${i + 1}`),
  'notes',
  'modifiedAt',
  // kolumny informacyjne (wyliczane; przy imporcie ignorowane)
  'testsPassed',
  'dayColor',
];

const csvCell = (v: string | number | null): string => {
  if (v === null) return '';
  let s = String(v);
  // Ochrona przed wstrzyknięciem formuł w arkuszach kalkulacyjnych.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportCsv(records: Measurement[]): string {
  const rows = [...records]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((m) => {
      const ev = evaluate(m);
      return [
        m.date,
        m.hrv,
        m.bodyBattery,
        m.ssz,
        m.morningRun.pace,
        ...m.morningRun.hr,
        m.notes ?? '',
        m.modifiedAt,
        ev.passed,
        ev.color,
      ]
        .map(csvCell)
        .join(',');
    });
  return [CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}

/* ------------------------------ Import ------------------------------- */

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export type ImportParse = { ok: true; records: Measurement[] } | { ok: false; errors: string[] };

export function parseImportJson(text: string, now = new Date()): ImportParse {
  const asFile = parseDataFile(text);
  if (asFile.ok) return { ok: true, records: asFile.data.measurements };
  // Dopuszczamy też „goną” tablicę rekordów (starszy eksport).
  if (text.length <= MAX_FILE_CHARS) {
    try {
      const json: unknown = JSON.parse(text);
      if (Array.isArray(json)) {
        const withTime = json.map((r) =>
          r && typeof r === 'object' && !('modifiedAt' in r) ? { ...r, modifiedAt: now.toISOString() } : r,
        );
        return parseMeasurementList(withTime, 'rekord');
      }
    } catch {
      /* nie JSON – zwracamy błędy z pierwszej próby */
    }
  }
  return { ok: false, errors: asFile.ok ? [] : asFile.errors };
}

export function parseImportCsv(text: string, now = new Date()): ImportParse {
  if (text.length > MAX_FILE_CHARS) return { ok: false, errors: ['plik jest zbyt duży'] };
  const rows = parseCsvRows(text.replace(/^﻿/, ''));
  if (rows.length < 2) return { ok: false, errors: ['plik CSV nie zawiera danych'] };
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);
  if (idx('date') < 0) return { ok: false, errors: ['brak kolumny „date” w nagłówku CSV'] };

  const errors: string[] = [];
  const raw: unknown[] = [];
  const num = (cells: string[], name: string, line: number): number | null => {
    const i = idx(name);
    if (i < 0) return null;
    const s = (cells[i] ?? '').trim().replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) {
      errors.push(`wiersz ${line}: „${name}” nie jest liczbą`);
      return null;
    }
    return n;
  };
  rows.slice(1).forEach((cells, k) => {
    const line = k + 2;
    const notesRaw = idx('notes') >= 0 ? (cells[idx('notes')] ?? '') : '';
    const notes = /^'[=+\-@\t\r]/.test(notesRaw) ? notesRaw.slice(1) : notesRaw;
    const mod = idx('modifiedAt') >= 0 ? (cells[idx('modifiedAt')] ?? '').trim() : '';
    raw.push({
      date: (cells[idx('date')] ?? '').trim(),
      hrv: num(cells, 'hrv', line),
      bodyBattery: num(cells, 'bodyBattery', line),
      ssz: num(cells, 'ssz', line),
      morningRun: {
        pace: num(cells, 'morningRunPace', line),
        hr: Array.from({ length: HR_COUNT }, (_, i) => num(cells, `hr${i + 1}`, line)),
      },
      notes,
      modifiedAt: mod || now.toISOString(),
    });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 10) };
  return parseMeasurementList(raw, 'wiersz');
}

export interface ImportPlan {
  added: Measurement[];
  identical: string[];
  different: { date: string; local: Measurement; incoming: Measurement }[];
}

/** Porównuje import z lokalną historią – nic nie zapisuje. */
export function planImport(local: LocalMeasurement[], incoming: Measurement[]): ImportPlan {
  const lmap = new Map(local.map((l) => [l.date, l]));
  const plan: ImportPlan = { added: [], identical: [], different: [] };
  for (const inc of incoming) {
    const l = lmap.get(inc.date);
    if (!l) plan.added.push(inc);
    else if (canonical(l) === canonical(inc)) plan.identical.push(inc.date);
    else plan.different.push({ date: inc.date, local: toPublic(l), incoming: inc });
  }
  return plan;
}

/**
 * Stosuje import po potwierdzeniu użytkownika. Nigdy nie usuwa lokalnych rekordów.
 * Rekordy zaimportowane są oznaczane jako oczekujące na synchronizację.
 * `overwriteDates` – daty, dla których użytkownik zgodził się zastąpić wersję lokalną.
 */
export async function applyImport(
  db: FatigueDB,
  plan: ImportPlan,
  overwriteDates: string[],
  now = new Date(),
): Promise<{ added: number; overwritten: number }> {
  const overwrite = new Set(overwriteDates);
  let added = 0;
  let overwritten = 0;
  await db.transaction('rw', db.measurements, async () => {
    for (const rec of plan.added) {
      if (await db.measurements.get(rec.date)) continue;
      await db.measurements.put({ ...rec, dirty: 1, syncedBase: null });
      added++;
    }
    for (const d of plan.different) {
      if (!overwrite.has(d.date)) continue;
      const cur = await db.measurements.get(d.date);
      if (!cur || canonical(cur) !== canonical(d.local)) continue; // zmienił się w międzyczasie
      await db.measurements.put({ ...d.incoming, modifiedAt: now.toISOString(), dirty: 1, syncedBase: cur.syncedBase });
      overwritten++;
    }
  });
  return { added, overwritten };
}
