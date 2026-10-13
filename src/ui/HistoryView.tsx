import { db } from '../db';
import { COLOR_LABEL, evaluate } from '../evaluate';
import { formatPace } from '../format';
import { getAllMeasurements } from '../store';
import type { LocalMeasurement } from '../types';
import { useLive } from './useLive';

export function HistoryView({ onEdit }: { onEdit: (date: string) => void }) {
  const rows = useLive(() => getAllMeasurements(db), [], [] as LocalMeasurement[]);
  const sorted = [...rows].reverse();
  if (sorted.length === 0) return <section className="card"><p>Brak zapisanych pomiarów.</p></section>;
  return (
    <section className="card">
      <h2>Historia ({sorted.length})</h2>
      <ul className="history">
        {sorted.map((m) => {
          const ev = evaluate(m);
          return (
            <li key={m.date}>
              <span className={`dot ${ev.color}`} title={COLOR_LABEL[ev.color]} />
              <div className="grow">
                <strong>{m.date}</strong> · {ev.passed}/{ev.total}
                {m.dirty === 1 && <span className="badge warn">oczekuje</span>}
                <div className="muted">
                  HRV {m.hrv ?? '–'} · BB {m.bodyBattery ?? '–'} · SSZ {m.ssz ?? '–'} · bieg{' '}
                  {formatPace(m.morningRun.pace) || '–'}
                  {ev.avgHr !== null && ` · śr. HR ${ev.avgHr.toFixed(0)}`}
                </div>
                {m.notes && <div className="muted note">{m.notes}</div>}
              </div>
              <button onClick={() => onEdit(m.date)}>Edytuj</button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
