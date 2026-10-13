import { useEffect, useMemo, useState } from 'react';
import { db } from '../db';
import { COLOR_LABEL, TEST_LABEL, evaluate, type TestKey } from '../evaluate';
import { ValidationError, safeErrorMessage } from '../errors';
import { formatDateTime, formatPace, parseNum, parsePace } from '../format';
import { countPending, getLastSync, localDateString, saveMeasurement } from '../store';
import { RULES } from '../rules.config';
import type { GitHubController } from './useGitHub';
import { useLive, useOnline } from './useLive';
import { HR_COUNT } from '../validate';

const STATUS_TEXT = { pass: 'zaliczony', fail: 'niezaliczony', missing: 'brak danych' } as const;

export function SyncStatusBar({ gh, onOpenSettings }: { gh: GitHubController; onOpenSettings: () => void }) {
  const pending = useLive(() => countPending(db), [], 0);
  const lastSync = useLive(() => getLastSync(db), [], null as string | null);
  const online = useOnline();
  const connText =
    gh.conn.status === 'connected'
      ? 'połączono (token w pamięci)'
      : gh.conn.status === 'checking'
        ? 'sprawdzanie…'
        : 'niepołączono';
  return (
    <section className="card status" aria-label="Status synchronizacji">
      <div className="row">
        <strong>GitHub:</strong> <span>{connText}</span>
        <span className={`badge ${online ? 'ok' : 'warn'}`}>{online ? 'online' : 'offline'}</span>
      </div>
      <div className="row">
        <span>Ostatnia synchronizacja: {formatDateTime(lastSync)}</span>
      </div>
      <div className="row">
        <span>
          Oczekuje na synchronizację: <strong>{pending}</strong>
        </span>
        <button className="link" onClick={onOpenSettings}>
          Synchronizacja →
        </button>
      </div>
    </section>
  );
}

export function TodayView({
  gh,
  date,
  setDate,
  onOpenSettings,
}: {
  gh: GitHubController;
  date: string;
  setDate: (d: string) => void;
  onOpenSettings: () => void;
}) {
  const [hrv, setHrv] = useState('');
  const [bb, setBb] = useState('');
  const [ssz, setSsz] = useState('');
  const [pace, setPace] = useState('');
  const [hr, setHr] = useState<string[]>(Array.from({ length: HR_COUNT }, () => ''));
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Wczytaj zapisany rekord dla wybranej daty.
  const stored = useLive(() => db.measurements.get(date), [date], undefined);
  useEffect(() => {
    setHrv(stored?.hrv?.toString() ?? '');
    setBb(stored?.bodyBattery?.toString() ?? '');
    setSsz(stored?.ssz?.toString() ?? '');
    setPace(formatPace(stored?.morningRun.pace ?? null));
    setHr(Array.from({ length: HR_COUNT }, (_, i) => stored?.morningRun.hr[i]?.toString() ?? ''));
    setNotes(stored?.notes ?? '');
    setMsg(null);
    // Wypełniamy formularz tylko przy zmianie daty lub pierwszym załadowaniu rekordu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, stored?.modifiedAt]);

  const draft = useMemo(() => {
    const clean = (n: number | null) => (n === null || Number.isNaN(n) ? null : n);
    return {
      hrv: clean(parseNum(hrv)),
      bodyBattery: clean(parseNum(bb)),
      ssz: clean(parseNum(ssz)),
      morningRun: { pace: clean(parsePace(pace)), hr: hr.map((v) => clean(parseNum(v))) },
    };
  }, [hrv, bb, ssz, pace, hr]);
  const ev = evaluate(draft);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const { changed } = await saveMeasurement(db, {
        date,
        hrv: parseNum(hrv),
        bodyBattery: parseNum(bb),
        ssz: parseNum(ssz),
        morningRun: { pace: parsePace(pace), hr: hr.map(parseNum) },
        notes: notes.trim() || undefined,
      });
      setMsg({ type: 'ok', text: changed ? 'Zapisano lokalnie (oczekuje na synchronizację).' : 'Brak zmian do zapisania.' });
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof ValidationError ? err.errors.join(' ') : safeErrorMessage(err) });
    }
  }

  const tests = Object.keys(TEST_LABEL) as TestKey[];
  return (
    <>
      <SyncStatusBar gh={gh} onOpenSettings={onOpenSettings} />
      <form className="card" onSubmit={save}>
        <h2>Pomiar dnia</h2>
        <label>
          Data
          <input type="date" value={date} max={localDateString()} onChange={(e) => e.target.value && setDate(e.target.value)} required />
        </label>
        <div className="grid3">
          <label>
            HRV (ms)
            <input inputMode="decimal" value={hrv} onChange={(e) => setHrv(e.target.value)} />
          </label>
          <label>
            Body Battery
            <input inputMode="decimal" value={bb} onChange={(e) => setBb(e.target.value)} />
          </label>
          <label>
            SSZ
            <input inputMode="decimal" value={ssz} onChange={(e) => setSsz(e.target.value)} />
          </label>
        </div>
        <fieldset>
          <legend>Morning Run Test</legend>
          <label>
            Tempo (min:s /km)
            <input placeholder="5:30" value={pace} onChange={(e) => setPace(e.target.value)} />
          </label>
          <div className="grid5">
            {hr.map((v, i) => (
              <label key={i}>
                HR {i + 1}
                <input
                  inputMode="numeric"
                  value={v}
                  onChange={(e) => setHr((prev) => prev.map((p, k) => (k === i ? e.target.value : p)))}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          Notatki
          <textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className={`day-color ${ev.color}`} role="status">
          <strong>Kolor dnia: {COLOR_LABEL[ev.color]}</strong>
          <span>
            zaliczone testy: {ev.passed}/{ev.total}
          </span>
        </div>
        <ul className="tests">
          {tests.map((t) => (
            <li key={t}>
              <span className={`dot ${ev.tests[t]}`} /> {TEST_LABEL[t]}: {STATUS_TEXT[ev.tests[t]]}
            </li>
          ))}
        </ul>
        {RULES.PLACEHOLDER && (
          <p className="hint">Progi oceny to wartości przykładowe – podmień je w <code>src/rules.config.ts</code>.</p>
        )}
        <button type="submit" className="primary">
          Zapisz lokalnie
        </button>
        {msg && <p className={msg.type === 'ok' ? 'msg ok' : 'msg err'}>{msg.text}</p>}
      </form>
    </>
  );
}
