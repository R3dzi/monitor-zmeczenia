import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '../src/evaluate';
import { countPending, getAllMeasurements, saveMeasurement } from '../src/store';
import { ValidationError } from '../src/errors';
import { makeCtx, rec, saveLocal } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('zapis lokalny offline (IndexedDB)', () => {
  it('zapisuje i odczytuje pomiar bez internetu, bez wywołań sieci i bez błędu', async () => {
    const { db } = makeCtx();
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('offline')));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    const { record, changed } = await saveLocal(db, rec('2026-10-01'));
    expect(changed).toBe(true);
    expect(record.dirty).toBe(1);

    const all = await getAllMeasurements(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ date: '2026-10-01', hrv: 60, bodyBattery: 70, ssz: 3, dirty: 1, syncedBase: null });
    expect(all[0].morningRun.hr).toHaveLength(10);
    expect(await countPending(db)).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled(); // zapis lokalny nigdy nie dotyka sieci
    vi.unstubAllGlobals();
  });

  it('ponowny zapis tych samych wartości nie zmienia stanu, edycja ustawia dirty', async () => {
    const { db } = makeCtx();
    await saveLocal(db, rec('2026-10-01'));
    const again = await saveLocal(db, rec('2026-10-01'));
    expect(again.changed).toBe(false);
    const edited = await saveLocal(db, rec('2026-10-01', { hrv: 41 }));
    expect(edited.changed).toBe(true);
    expect((await db.measurements.get('2026-10-01'))?.hrv).toBe(41);
  });

  it('odrzuca wartości spoza zakresu, złą datę i puste dane', async () => {
    const { db } = makeCtx();
    await expect(saveLocal(db, rec('2026-10-01', { hrv: 9999 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveLocal(db, rec('2026-13-40'))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      saveMeasurement(db, { date: '2026-10-01', hrv: null, bodyBattery: null, ssz: null, morningRun: { pace: null, hr: Array(10).fill(null) } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.measurements.count()).toBe(0);
  });
});

describe('wyliczanie statusów', () => {
  it('status, liczba zaliczonych i kolor wynikają z wartości, nie z danych statusowych', () => {
    const steady = { pace: 330, hr: [130, 131, 130, 132, 131, 133, 132, 134, 133, 134] }; // mały dryf tętna
    const base = rec('2026-10-01', { morningRun: steady });
    const polluted = { ...base, color: 'red', passed: 0, status: 'fail' } as typeof base;
    expect(evaluate(base)).toEqual(evaluate(polluted));
    expect(evaluate(base)).toMatchObject({ passed: 4, completed: 4, color: 'green' });
    const bad = evaluate({ ...base, hrv: 10, bodyBattery: 10, ssz: 9 });
    expect(bad.passed).toBe(1);
    expect(bad.color).toBe('red');
    expect(evaluate({ hrv: null, bodyBattery: null, ssz: null, morningRun: { pace: null, hr: Array(10).fill(null) } }).color).toBe('gray');
  });
});
