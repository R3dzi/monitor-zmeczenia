import type { Measurement } from '../types';
import { formatPace } from '../format';
import type { GitHubController } from './useGitHub';

const MODE_TITLE = {
  sync: 'Synchronizuj z GitHubem',
  pull: 'Pobierz dane z GitHuba',
  push: 'Wyślij dane do GitHuba',
} as const;

export function describe(m: Measurement): string {
  return `HRV ${m.hrv ?? '–'}, BB ${m.bodyBattery ?? '–'}, SSZ ${m.ssz ?? '–'}, bieg ${formatPace(m.morningRun.pace) || '–'}, zmieniono ${new Date(m.modifiedAt).toLocaleString('pl-PL')}`;
}

export function SyncDialog({ gh }: { gh: GitHubController }) {
  const d = gh.dialog;
  const p = gh.preview;
  if (!d || !p) return null;
  const { mode, plan, phase } = d;
  const conflicts = plan.merge.conflicts;
  const unresolved = p.conflictsLeft;
  const nothing = p.pulledNew + p.pulledUpdated + p.pushedNew + p.pushedUpdated === 0 && conflicts.length === 0;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={MODE_TITLE[mode]}>
      <div className="dialog">
        <h2>{MODE_TITLE[mode]}</h2>

        {phase === 'done' && d.summary ? (
          <>
            <p className="msg ok">Zakończono. GitHub potwierdził zapis; rekordy oznaczono jako zsynchronizowane.</p>
            <SummaryList s={d.summary} mode={mode} />
            <button className="primary" onClick={gh.closeDialog}>Zamknij</button>
          </>
        ) : phase === 'error' ? (
          <>
            <p className="msg err">{d.message}</p>
            <p className="hint">Dane lokalne nie zostały usunięte i nadal oczekują na synchronizację.</p>
            <button onClick={gh.closeDialog}>Zamknij</button>
          </>
        ) : (
          <>
            {d.message && <p className="msg err">{d.message}</p>}
            <p className="hint">
              {plan.remote.exists ? 'Plik na GitHubie został pobrany i zwalidowany.' : 'Pliku danych jeszcze nie ma na GitHubie – zostanie utworzony.'}{' '}
              Nic nie zostało jeszcze zmienione.
            </p>
            <SummaryList s={p} mode={mode} />

            {conflicts.length > 0 && (
              <div className="conflicts">
                <h3>Konflikty ({conflicts.length}) – wybierz wersję</h3>
                {conflicts.map((c) => (
                  <fieldset key={c.date}>
                    <legend>{c.date}</legend>
                    <label className="radio">
                      <input type="radio" name={`c-${c.date}`} checked={d.resolutions[c.date] === 'local'} onChange={() => gh.resolve(c.date, 'local')} />
                      <span>
                        <strong>Lokalna:</strong> {describe(c.local)}
                      </span>
                    </label>
                    <label className="radio">
                      <input type="radio" name={`c-${c.date}`} checked={d.resolutions[c.date] === 'remote'} onChange={() => gh.resolve(c.date, 'remote')} />
                      <span>
                        <strong>Z GitHuba:</strong> {describe(c.remote)}
                      </span>
                    </label>
                  </fieldset>
                ))}
              </div>
            )}

            <div className="row end">
              <button onClick={gh.closeDialog} disabled={phase === 'running'}>Anuluj</button>
              <button className="primary" onClick={() => void gh.confirm()} disabled={phase === 'running' || unresolved > 0}>
                {phase === 'running' ? 'Trwa synchronizacja…' : nothing ? 'Zakończ (brak zmian)' : 'Zastosuj'}
              </button>
            </div>
            {unresolved > 0 && <p className="hint">Rozstrzygnij wszystkie konflikty, aby kontynuować.</p>}
            {phase === 'running' && <progress aria-label="Postęp synchronizacji" />}
          </>
        )}
      </div>
    </div>
  );
}

function SummaryList({ s, mode }: { s: { pulledNew: number; pulledUpdated: number; pushedNew: number; pushedUpdated: number; identical: number }; mode: 'sync' | 'pull' | 'push' }) {
  return (
    <ul className="summary">
      {mode !== 'push' && (
        <li>
          Z GitHuba → urządzenie: <strong>{s.pulledNew}</strong> nowych, <strong>{s.pulledUpdated}</strong> zaktualizowanych
        </li>
      )}
      {mode !== 'pull' && (
        <li>
          Urządzenie → GitHub: <strong>{s.pushedNew}</strong> nowych, <strong>{s.pushedUpdated}</strong> zaktualizowanych
        </li>
      )}
      <li>Bez zmian (identyczne): {s.identical}</li>
      <li className="muted">Żadne rekordy nie są usuwane.</li>
    </ul>
  );
}
