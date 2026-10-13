import { useRef, useState } from 'react';
import { db } from '../db';
import { safeErrorMessage } from '../errors';
import { formatDateTime } from '../format';
import {
  applyImport,
  exportCsv,
  exportJson,
  parseImportCsv,
  parseImportJson,
  planImport,
  type ImportPlan,
} from '../importExport';
import { RULES } from '../rules.config';
import { MAX_FILE_CHARS } from '../validate';
import { countPending, getAllMeasurements, getLastSync } from '../store';
import { describe } from './SyncDialog';
import type { GitHubController } from './useGitHub';
import { useLive, useOnline } from './useLive';

function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SettingsView({ gh }: { gh: GitHubController }) {
  const online = useOnline();
  const pending = useLive(() => countPending(db), [], 0);
  const lastSync = useLive(() => getLastSync(db), [], null as string | null);
  const { config, conn } = gh;
  const canSync = gh.connected && online && !gh.busy && !gh.dialog;

  const connLabel =
    conn.status === 'connected' ? 'Połączono – token jest w pamięci tej karty'
    : conn.status === 'checking' ? 'Sprawdzanie połączenia…'
    : conn.status === 'error' ? `Błąd: ${conn.message}`
    : 'Niepołączono';

  return (
    <>
      <section className="card">
        <h2>Połącz z GitHubem</h2>
        <p className="hint">
          Synchronizacja jest opcjonalna i uruchamiana wyłącznie ręcznie. Aplikacja działa w pełni offline bez GitHuba.
        </p>
        <div className="grid2">
          <label>
            Właściciel repozytorium
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={config.owner} onChange={(e) => gh.updateConfig({ owner: e.target.value.trim() })} />
          </label>
          <label>
            Nazwa prywatnego repozytorium
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={config.repo} onChange={(e) => gh.updateConfig({ repo: e.target.value.trim() })} />
          </label>
          <label>
            Ścieżka pliku danych
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={config.path} onChange={(e) => gh.updateConfig({ path: e.target.value.trim() })} />
          </label>
          <label>
            Gałąź
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={config.branch} onChange={(e) => gh.updateConfig({ branch: e.target.value.trim() })} />
          </label>
        </div>
        <label>
          Token (fine-grained Personal Access Token)
          <input
            type="password"
            name="gh-token-not-saved"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={gh.tokenInput}
            onChange={(e) => gh.setTokenInput(e.target.value)}
            placeholder="wklej token"
          />
        </label>
        <div className="info">
          <strong>Wymagane uprawnienia:</strong> dostęp tylko do jednego, wybranego prywatnego repozytorium oraz
          uprawnienie <em>Contents: Read and write</em>. Nie nadawaj dostępu do wszystkich repozytoriów ani uprawnień administracyjnych.
          <br />
          <strong>Token nie jest nigdzie zapisywany</strong> – po odświeżeniu lub zamknięciu strony trzeba wkleić go ponownie.
        </div>
        <div className="row">
          <button className="primary" onClick={() => void gh.connect()} disabled={gh.busy || conn.status === 'checking' || !gh.tokenInput}>
            Sprawdź połączenie
          </button>
          <button onClick={gh.disconnect} disabled={conn.status === 'disconnected' && !gh.tokenInput}>
            Rozłącz GitHub
          </button>
        </div>
        <p className={conn.status === 'error' ? 'msg err' : conn.status === 'connected' ? 'msg ok' : 'muted'}>{connLabel}</p>
        {conn.status === 'connected' && conn.warning && <p className="hint">{conn.warning}</p>}
      </section>

      <section className="card">
        <h2>Synchronizacja</h2>
        <ul className="summary">
          <li>Status: {gh.connected ? 'połączono' : 'niepołączono'}</li>
          <li>Ostatnia udana synchronizacja: {formatDateTime(lastSync)}</li>
          <li>Zmiany oczekujące na synchronizację: <strong>{pending}</strong></li>
          {!online && <li className="msg err">Brak internetu – synchronizacja niedostępna (zapis lokalny działa normalnie).</li>}
        </ul>
        <div className="stack">
          <button className="primary" disabled={!canSync} onClick={() => void gh.startSync('sync')}>Synchronizuj z GitHubem</button>
          <button disabled={!canSync} onClick={() => void gh.startSync('pull')}>Pobierz dane z GitHuba</button>
          <button disabled={!canSync} onClick={() => void gh.startSync('push')}>Wyślij dane do GitHuba</button>
          <button onClick={gh.disconnect} disabled={!gh.connected}>Rozłącz GitHub</button>
        </div>
        {gh.busy && <progress aria-label="Trwa operacja" />}
        {gh.error && <p className="msg err">{gh.error}</p>}
        <p className="hint">Przed każdym pobraniem lub wysłaniem zobaczysz podsumowanie. Synchronizacja nigdy nie startuje sama.</p>
      </section>

      <BackupSection />

      <section className="card">
        <h2>Prywatność</h2>
        <p className="hint">
          Prywatne repozytorium GitHub jest <strong>kopią danych</strong>, a nie szyfrowaną bazą medyczną. Aplikacja nie zawiera telemetrii
          i nie wysyła pomiarów nigdzie poza repozytorium, które sam skonfigurujesz. Token jest wysyłany wyłącznie do api.github.com.
        </p>
        {RULES.PLACEHOLDER && (
          <p className="hint">Progi ocen testów i kolorów dnia są wartościami przykładowymi (<code>src/rules.config.ts</code>).</p>
        )}
      </section>
    </>
  );
}

function BackupSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);

  async function exportAs(kind: 'json' | 'csv') {
    const all = await getAllMeasurements(db);
    const day = new Date().toISOString().slice(0, 10);
    if (kind === 'json') download(`monitor-zmeczenia-${day}.json`, exportJson(all), 'application/json');
    else download(`monitor-zmeczenia-${day}.csv`, exportCsv(all), 'text/csv');
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    setPlan(null);
    setErrors([]);
    setResult(null);
    if (!file) return;
    if (file.size > MAX_FILE_CHARS) {
      setErrors(['Plik jest zbyt duży.']);
      return;
    }
    try {
      const text = await file.text();
      const parsed = file.name.toLowerCase().endsWith('.csv') ? parseImportCsv(text) : parseImportJson(text);
      if (!parsed.ok) {
        setErrors(parsed.errors);
        return;
      }
      const local = await db.measurements.toArray();
      setPlan(planImport(local, parsed.records));
      setOverwrite({});
    } catch (err) {
      setErrors([safeErrorMessage(err)]);
    }
  }

  async function apply() {
    if (!plan) return;
    const dates = Object.entries(overwrite).filter(([, v]) => v).map(([k]) => k);
    const r = await applyImport(db, plan, dates);
    setResult(`Zaimportowano: ${r.added} nowych, ${r.overwritten} zastąpionych. Zmiany czekają na synchronizację.`);
    setPlan(null);
  }

  return (
    <section className="card">
      <h2>Kopie zapasowe</h2>
      <div className="row">
        <button onClick={() => void exportAs('json')}>Eksport JSON</button>
        <button onClick={() => void exportAs('csv')}>Eksport CSV</button>
        <button onClick={() => fileRef.current?.click()}>Import (JSON/CSV)</button>
        <input ref={fileRef} type="file" accept=".json,.csv,application/json,text/csv" hidden onChange={(e) => void onFile(e)} />
      </div>
      {errors.length > 0 && (
        <div className="msg err">
          Import odrzucony – plik jest nieprawidłowy. Lokalne dane nie zostały zmienione.
          <ul>{errors.map((er, i) => <li key={i}>{er}</li>)}</ul>
        </div>
      )}
      {result && <p className="msg ok">{result}</p>}
      {plan && (
        <div className="import">
          <h3>Podsumowanie importu</h3>
          <ul className="summary">
            <li>Nowe rekordy do dodania: <strong>{plan.added.length}</strong></li>
            <li>Identyczne (pominięte): {plan.identical.length}</li>
            <li>Różniące się od lokalnych: <strong>{plan.different.length}</strong></li>
          </ul>
          {plan.different.map((d) => (
            <fieldset key={d.date}>
              <legend>{d.date}</legend>
              <div className="muted">Lokalnie: {describe(d.local)}</div>
              <div className="muted">Import: {describe(d.incoming)}</div>
              <label className="radio">
                <input type="checkbox" checked={!!overwrite[d.date]} onChange={(e) => setOverwrite((o) => ({ ...o, [d.date]: e.target.checked }))} />
                <span>Zastąp wersję lokalną importowaną</span>
              </label>
            </fieldset>
          ))}
          <p className="hint">Lokalna historia nie zostanie usunięta ani zastąpiona bez Twojego zaznaczenia.</p>
          <div className="row end">
            <button onClick={() => setPlan(null)}>Anuluj</button>
            <button className="primary" onClick={() => void apply()}>Potwierdź import</button>
          </div>
        </div>
      )}
    </section>
  );
}
