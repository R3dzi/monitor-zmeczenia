/** "" → null, "5,5" → 5.5, nieliczba → NaN (odrzucana przez walidację). */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  return Number(t);
}

/** "5:30" → 330 s/km; "330" → 330; "" → null; błąd → NaN. */
export function parsePace(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return Number(t.replace(',', '.'));
}

export function formatPace(sec: number | null): string {
  if (sec === null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'nigdy';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'nigdy' : d.toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${d}.${m}`;
}
