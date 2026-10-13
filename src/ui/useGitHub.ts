import { useCallback, useEffect, useState } from 'react';
import { db } from '../db';
import { safeErrorMessage } from '../errors';
import { validateRepoConfig } from '../github/client';
import type { Resolution, SyncMode } from '../merge';
import { getConfig, setConfig } from '../store';
import { executePlan, preparePlan, summarize, type SyncPlan, type SyncSummary } from '../sync/syncService';
import { DEFAULT_CONFIG, type RepoConfig } from '../types';
import { auth, githubClient, syncLock } from './session';

export type Conn =
  | { status: 'disconnected' }
  | { status: 'checking' }
  | { status: 'connected'; warning?: string }
  | { status: 'error'; message: string };

export interface DialogState {
  mode: SyncMode;
  plan: SyncPlan;
  resolutions: Record<string, Resolution>;
  phase: 'review' | 'running' | 'done' | 'error';
  summary?: SyncSummary;
  message?: string;
}

export type GitHubController = ReturnType<typeof useGitHub>;

export function useGitHub() {
  const [config, setCfg] = useState<RepoConfig>(DEFAULT_CONFIG);
  const [conn, setConn] = useState<Conn>({ status: 'disconnected' });
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  useEffect(() => {
    void getConfig(db).then(setCfg);
  }, []);

  // Token znika także przy zamknięciu/zamrożeniu strony (np. bfcache).
  useEffect(() => {
    const onHide = () => auth.clear();
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted && !auth.isAuthenticated()) setConn({ status: 'disconnected' });
    };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  const updateConfig = useCallback((patch: Partial<RepoConfig>) => {
    setCfg((prev) => {
      const next = { ...prev, ...patch };
      void setConfig(db, next); // ustawienia niesekretne
      return next;
    });
  }, []);

  const connected = conn.status === 'connected' && auth.isAuthenticated();

  const connect = useCallback(async () => {
    setError(null);
    const problems = validateRepoConfig(config);
    if (problems.length) {
      setConn({ status: 'error', message: problems[0] });
      return;
    }
    try {
      auth.setToken(tokenInput);
    } catch (e) {
      // Komunikat pochodzi z MemoryTokenAuth.setToken i nie zawiera wartości tokenu.
      setConn({ status: 'error', message: e instanceof Error ? e.message : 'Nieprawidłowy token.' });
      return;
    }
    setConn({ status: 'checking' });
    try {
      const info = await githubClient.getRepo(config.owner, config.repo);
      if (!info.isPrivate) {
        auth.clear();
        setConn({
          status: 'error',
          message: 'To repozytorium jest PUBLICZNE. Dane pomiarowe można wysyłać tylko do repozytorium prywatnego.',
        });
        return;
      }
      if (info.canPush === false) {
        auth.clear();
        setConn({ status: 'error', message: 'Token nie ma prawa zapisu. Wymagane uprawnienie: Contents: Read and write.' });
        return;
      }
      setTokenInput(''); // token jest już tylko w pamięci klienta
      setConn({
        status: 'connected',
        warning: info.canPush === null ? 'Nie udało się potwierdzić prawa zapisu – zostanie sprawdzone przy pierwszym zapisie.' : undefined,
      });
    } catch (e) {
      auth.clear();
      setConn({ status: 'error', message: safeErrorMessage(e) });
    }
  }, [config, tokenInput]);

  const disconnect = useCallback(() => {
    auth.clear();
    setTokenInput('');
    setDialog(null);
    setError(null);
    setConn({ status: 'disconnected' });
  }, []);

  const startSync = useCallback(
    async (mode: SyncMode) => {
      setError(null);
      if (!connected) {
        setError('Najpierw połącz z GitHubem (wklej token i sprawdź połączenie).');
        return;
      }
      try {
        setBusy(true);
        const plan = await syncLock.run(() => preparePlan({ db, client: githubClient, config }, mode));
        setDialog({ mode, plan, resolutions: {}, phase: 'review' });
      } catch (e) {
        setError(safeErrorMessage(e));
        if ((e as { kind?: string }).kind === 'auth') {
          auth.clear();
          setConn({ status: 'disconnected' });
        }
      } finally {
        setBusy(false);
      }
    },
    [connected, config],
  );

  const resolve = useCallback((date: string, choice: Resolution) => {
    setDialog((d) => (d ? { ...d, resolutions: { ...d.resolutions, [date]: choice } } : d));
  }, []);

  const confirm = useCallback(async () => {
    if (!dialog) return;
    const { plan, resolutions } = dialog;
    setDialog({ ...dialog, phase: 'running' });
    setBusy(true);
    try {
      const result = await syncLock.run(() => executePlan({ db, client: githubClient, config }, plan, resolutions));
      if (result.status === 'needs-resolution') {
        setDialog({
          mode: dialog.mode,
          plan: result.plan,
          resolutions: {},
          phase: 'review',
          message: 'Plik na GitHubie zmienił się w trakcie synchronizacji – sprawdź ponownie podsumowanie.',
        });
      } else {
        setDialog({ ...dialog, plan, phase: 'done', summary: result.summary });
      }
    } catch (e) {
      setDialog({ ...dialog, phase: 'error', message: safeErrorMessage(e) });
      if ((e as { kind?: string }).kind === 'auth') {
        auth.clear();
        setConn({ status: 'disconnected' });
      }
    } finally {
      setBusy(false);
    }
  }, [dialog, config]);

  const closeDialog = useCallback(() => setDialog(null), []);

  const preview = dialog ? summarize(dialog.plan, dialog.resolutions) : null;

  return {
    config,
    updateConfig,
    conn,
    connected,
    tokenInput,
    setTokenInput,
    busy,
    error,
    connect,
    disconnect,
    startSync,
    dialog,
    preview,
    resolve,
    confirm,
    closeDialog,
  };
}
