import { describe, expect, it } from 'vitest';
import { applyImport, exportCsv, exportJson, parseImportCsv, parseImportJson, planImport } from '../src/importExport';
import { parseDataFile } from '../src/validate';
import { makeCtx, rec, saveLocal } from './helpers';

describe('eksport / import', () => {
  it('JSON: eksport → import daje te same rekordy', () => {
    const records = [rec('2026-10-01'), rec('2026-10-02', { notes: 'ciężka noc' })];
    const parsed = parseImportJson(exportJson(records));
    expect(parsed.ok && parsed.records).toEqual(records);
  });

  it('CSV: eksport → import zachowuje wartości, a notatki z formułami są zabezpieczone', () => {
    const records = [rec('2026-10-01', { notes: '=HYPERLINK("http://x")' }), rec('2026-10-02', { hrv: null })];
    const csv = exportCsv(records);
    expect(csv).toContain("'=HYPERLINK");
    const parsed = parseImportCsv(csv);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.records[0].notes).toBe('=HYPERLINK("http://x")');
      expect(parsed.records[1].hrv).toBeNull();
      expect(parsed.records[0].morningRun.hr).toEqual(records[0].morningRun.hr);
    }
  });

  it('odrzuca nieprawidłowy import (zakres, data, schemat) bez żadnych zapisów', () => {
    expect(parseImportJson('nie json').ok).toBe(false);
    expect(parseImportJson(JSON.stringify({ schemaVersion: 2, updatedAt: '2026-10-01T00:00:00Z', measurements: [] })).ok).toBe(false);
    expect(parseImportCsv('date,hrv\n2026-10-01,abc').ok).toBe(false);
    expect(parseImportCsv('date,hrv\n2026-10-01,9999').ok).toBe(false);
    expect(parseImportCsv('date,hrv\n2026-02-30,50').ok).toBe(false);
  });

  it('dane statusowe z zewnętrznego JSON są ignorowane przy odczycie', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-10-01T00:00:00.000Z',
      measurements: [{ ...rec('2026-10-01'), color: 'green', passed: 4, status: { hrv: 'pass' } }],
    });
    const parsed = parseDataFile(text);
    expect(parsed.ok && Object.keys(parsed.data.measurements[0]).sort()).toEqual(['bodyBattery', 'date', 'hrv', 'modifiedAt', 'morningRun', 'ssz']);
  });

  it('import pokazuje różnice i nie zastępuje lokalnej historii bez zgody', async () => {
    const { db } = makeCtx();
    await saveLocal(db, rec('2026-10-01', { hrv: 40 }));
    await saveLocal(db, rec('2026-10-02'));
    const incoming = [rec('2026-10-01', { hrv: 90 }), rec('2026-10-02'), rec('2026-10-03')];
    const plan = planImport(await db.measurements.toArray(), incoming);
    expect(plan.added.map((m) => m.date)).toEqual(['2026-10-03']);
    expect(plan.identical).toEqual(['2026-10-02']);
    expect(plan.different.map((d) => d.date)).toEqual(['2026-10-01']);

    expect(await applyImport(db, plan, [])).toEqual({ added: 1, overwritten: 0 });
    expect((await db.measurements.get('2026-10-01'))?.hrv).toBe(40); // nietknięte
    expect(await db.measurements.count()).toBe(3);
    expect((await db.measurements.get('2026-10-03'))?.dirty).toBe(1);

    expect(await applyImport(db, plan, ['2026-10-01'])).toMatchObject({ overwritten: 1 });
    expect((await db.measurements.get('2026-10-01'))?.hrv).toBe(90);
  });
});
