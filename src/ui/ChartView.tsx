import { useState } from 'react';
import { db } from '../db';
import { COLOR_LABEL, evaluate } from '../evaluate';
import { shortDate } from '../format';
import { localDateString } from '../store';
import type { LocalMeasurement } from '../types';
import { useLive } from './useLive';

type MetricKey = 'hrv' | 'bodyBattery' | 'ssz' | 'avgHr';
const METRICS: { key: MetricKey; label: string }[] = [
  { key: 'hrv', label: 'HRV' },
  { key: 'bodyBattery', label: 'Body Battery' },
  { key: 'ssz', label: 'SSZ' },
  { key: 'avgHr', label: 'Śr. HR biegu' },
];

export function lastNDates(n: number, end = new Date()): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - (n - 1 - i));
    return localDateString(d);
  });
}

function valueOf(m: LocalMeasurement | undefined, key: MetricKey): number | null {
  if (!m) return null;
  if (key === 'avgHr') return evaluate(m).avgHr;
  return m[key];
}

export function ChartView() {
  const [metric, setMetric] = useState<MetricKey>('hrv');
  const dates = lastNDates(7);
  const rows = useLive(() => db.measurements.where('date').between(dates[0], dates[6], true, true).toArray(), [dates[0]], [] as LocalMeasurement[]);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const values = dates.map((d) => valueOf(byDate.get(d), metric));
  const present = values.filter((v): v is number => v !== null);

  const W = 320;
  const H = 170;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const lo = present.length ? Math.min(...present) : 0;
  const hi = present.length ? Math.max(...present) : 1;
  const span = hi - lo || 1;
  const min = lo - span * 0.15;
  const max = hi + span * 0.15;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / 6;
  const y = (v: number) => pad.t + ((max - v) * (H - pad.t - pad.b)) / (max - min);

  const segments: [number, number][][] = [];
  let cur: [number, number][] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else cur.push([x(i), y(v)]);
  });
  if (cur.length) segments.push(cur);

  return (
    <section className="card">
      <h2>Ostatnie 7 dni</h2>
      <div className="tabs small" role="tablist">
        {METRICS.map((m) => (
          <button key={m.key} role="tab" aria-selected={metric === m.key} className={metric === m.key ? 'active' : ''} onClick={() => setMetric(m.key)}>
            {m.label}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Wykres: ${METRICS.find((m) => m.key === metric)?.label}, ostatnie 7 dni`}>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="axis" />
        {present.length > 0 && (
          <>
            <text x={4} y={y(hi) + 4} className="tick">{Math.round(hi * 10) / 10}</text>
            <text x={4} y={y(lo) + 4} className="tick">{Math.round(lo * 10) / 10}</text>
          </>
        )}
        {segments.map((seg, i) => (
          <polyline key={i} points={seg.map((p) => p.join(',')).join(' ')} className="line" />
        ))}
        {values.map((v, i) =>
          v === null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3.5} className="pt"><title>{`${dates[i]}: ${Math.round(v * 10) / 10}`}</title></circle>,
        )}
        {dates.map((d, i) => (
          <text key={d} x={x(i)} y={H - 8} textAnchor="middle" className="tick">{shortDate(d)}</text>
        ))}
        {present.length === 0 && <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">Brak danych</text>}
      </svg>
      <div className="daystrip">
        {dates.map((d) => {
          const m = byDate.get(d);
          const ev = m ? evaluate(m) : null;
          return (
            <div key={d} className="daychip">
              <span className={`dot ${ev?.color ?? 'gray'}`} title={COLOR_LABEL[ev?.color ?? 'gray']} />
              <small>{shortDate(d)}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}
