import { GitHubError } from '../errors';
import type { RepoConfig } from '../types';
import type { AuthProvider } from './auth';

/** Jedyny adres, do którego kiedykolwiek wysyłamy token. */
export const API_BASE = 'https://api.github.com';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,200}$/;

/** Waliduje konfigurację repozytorium (chroni też przed „wstrzyknięciem” ścieżki do URL). */
export function validateRepoConfig(cfg: RepoConfig): string[] {
  const errors: string[] = [];
  if (!NAME_RE.test(cfg.owner)) errors.push('Właściciel repozytorium: dozwolone litery, cyfry, „-”, „_”, „.”.');
  if (!NAME_RE.test(cfg.repo)) errors.push('Nazwa repozytorium: dozwolone litery, cyfry, „-”, „_”, „.”.');
  if (!BRANCH_RE.test(cfg.branch) || cfg.branch.includes('..')) errors.push('Nieprawidłowa nazwa gałęzi.');
  const p = cfg.path;
  if (
    !p ||
    p.length > 300 ||
    p.startsWith('/') ||
    p.endsWith('/') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..') ||
    /[\\?#\0]/.test(p)
  ) {
    errors.push('Ścieżka pliku danych jest nieprawidłowa (np. data.json lub dane/data.json).');
  }
  return errors;
}

export interface RepoInfo {
  isPrivate: boolean;
  /** null = GitHub nie zwrócił informacji o uprawnieniach. */
  canPush: boolean | null;
}

export type RemoteFile = { exists: false } | { exists: true; sha: string; text: string };

export interface PutResult {
  contentSha: string;
  commitSha: string;
}

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class GitHubClient {
  constructor(
    private readonly auth: AuthProvider & { redact?: (t: string) => string },
    private readonly fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  private redact(text: string): string {
    return this.auth.redact ? this.auth.redact(text) : text;
  }

  private contentsPath(cfg: RepoConfig): string {
    const errors = validateRepoConfig(cfg);
    if (errors.length) throw new GitHubError('invalid-config', errors[0]);
    const filePath = cfg.path.split('/').map(encodeURIComponent).join('/');
    return `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${filePath}`;
  }

  private async request(
    method: 'GET' | 'PUT',
    path: string,
    opts: { body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const authorization = this.auth.getAuthorizationHeader();
    if (!authorization) {
      throw new GitHubError('no-token', 'Brak tokenu GitHub. Wklej token ponownie (nie jest zapamiętywany po odświeżeniu strony).');
    }
    const url = API_BASE + path;
    if (!url.startsWith(API_BASE + '/')) {
      throw new GitHubError('invalid-config', 'Niedozwolony adres żądania.');
    }
    const headers: Record<string, string> = {
      Accept: opts.accept ?? 'application/vnd.github+json',
      Authorization: authorization,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const init: RequestInit = {
      method,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch {
      // Treść oryginalnego błędu pomijamy celowo – nie ryzykujemy wycieku danych żądania.
      throw new GitHubError('network', 'Brak połączenia z internetem lub GitHub jest nieosiągalny.');
    }
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async toError(res: Response): Promise<GitHubError> {
    let message = '';
    try {
      const body: unknown = await res.json();
      if (isRecord(body) && typeof body.message === 'string') message = this.redact(body.message).slice(0, 200);
    } catch {
      /* brak treści JSON */
    }
    const status = res.status;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const resetAt = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000) : undefined;

    if (status === 401) {
      return new GitHubError('auth', 'Token jest nieprawidłowy, wygasł albo został unieważniony. Wygeneruj nowy token i wklej go ponownie.', { status });
    }
    if (status === 429 || (status === 403 && (remaining === '0' || res.headers.has('retry-after') || /rate limit/i.test(message)))) {
      const when = resetAt ? ` Spróbuj po ${resetAt.toLocaleTimeString('pl-PL')}.` : ' Spróbuj ponownie za chwilę.';
      return new GitHubError('ratelimit', 'Przekroczono limit zapytań GitHub API.' + when, { status, resetAt });
    }
    if (status === 403) {
      return new GitHubError('forbidden', 'Token nie ma wystarczających uprawnień. Wymagane: dostęp do tego jednego repozytorium oraz Contents: Read and write.', { status });
    }
    if (status === 404) {
      return new GitHubError('notfound', message || 'Nie znaleziono zasobu.', { status });
    }
    if (status === 409) {
      return new GitHubError('conflict', 'Plik na GitHubie zmienił się w międzyczasie (konflikt wersji).', { status });
    }
    if (status === 422) {
      if (/sha/i.test(message)) {
        return new GitHubError('conflict', 'Plik na GitHubie zmienił się w międzyczasie (konflikt wersji).', { status });
      }
      return new GitHubError('validation', `GitHub odrzucił żądanie${message ? `: ${message}` : '.'}`, { status });
    }
    if (status >= 500) {
      return new GitHubError('server', `Błąd po stronie GitHuba (${status}). Spróbuj ponownie później.`, { status });
    }
    return new GitHubError('validation', `Nieoczekiwana odpowiedź GitHuba (${status}).`, { status });
  }

  /** Sprawdza dostęp do repozytorium: istnienie, prywatność i (jeśli znane) prawo zapisu. */
  async getRepo(owner: string, repo: string): Promise<RepoInfo> {
    const errors = validateRepoConfig({ owner, repo, path: 'data.json', branch: 'main' });
    if (errors.length) throw new GitHubError('invalid-config', errors[0]);
    try {
      const res = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      const body: unknown = await res.json();
      if (!isRecord(body) || typeof body.private !== 'boolean') {
        throw new GitHubError('invalid-response', 'Nieoczekiwana odpowiedź GitHuba.');
      }
      let canPush: boolean | null = null;
      if (isRecord(body.permissions) && typeof body.permissions.push === 'boolean') canPush = body.permissions.push;
      return { isPrivate: body.private, canPush };
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notfound') {
        throw new GitHubError(
          'repo-not-found',
          'Nie znaleziono repozytorium albo token nie ma do niego dostępu. Sprawdź właściciela, nazwę i to, czy token obejmuje to repozytorium.',
          { status: 404 },
        );
      }
      throw e;
    }
  }

  /** Pobiera plik. Zwraca { exists: false }, jeśli pliku jeszcze nie ma. */
  async getFile(cfg: RepoConfig): Promise<RemoteFile> {
    const base = this.contentsPath(cfg);
    const url = `${base}?ref=${encodeURIComponent(cfg.branch)}`;
    let res: Response;
    try {
      res = await this.request('GET', url);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'notfound') {
        // 404 oznacza brak pliku, brak gałęzi albo brak dostępu do repo – rozróżniamy.
        await this.getRepo(cfg.owner, cfg.repo); // rzuci repo-not-found, jeśli repo niedostępne
        if (/ref|branch|commit/i.test(e.message)) {
          throw new GitHubError('branch-missing', `Nie znaleziono gałęzi „${cfg.branch}” w repozytorium.`, { status: 404 });
        }
        return { exists: false };
      }
      throw e;
    }
    const body: unknown = await res.json().catch(() => null);
    if (Array.isArray(body)) {
      throw new GitHubError('invalid-response', 'Wskazana ścieżka jest katalogiem, a nie plikiem.');
    }
    if (!isRecord(body) || typeof body.sha !== 'string' || body.type !== 'file') {
      throw new GitHubError('invalid-response', 'Nieoczekiwana odpowiedź GitHuba przy pobieraniu pliku.');
    }
    if (body.size === 0) return { exists: true, sha: body.sha, text: '' };
    if (body.encoding === 'base64' && typeof body.content === 'string' && body.content.length > 0) {
      try {
        return { exists: true, sha: body.sha, text: fromBase64(body.content) };
      } catch {
        throw new GitHubError('invalid-response', 'Nie udało się zdekodować zawartości pliku (Base64/UTF-8).');
      }
    }
    // Pliki > 1 MB: API nie zwraca treści w JSON – pobieramy wersję „raw”.
    const raw = await this.request('GET', url, { accept: 'application/vnd.github.raw+json' });
    return { exists: true, sha: body.sha, text: await raw.text() };
  }

  /**
   * Zapisuje plik. `sha` podajemy tylko przy aktualizacji istniejącego pliku
   * (przy tworzeniu – bez sha). Sukces potwierdzamy dopiero po otrzymaniu od GitHuba
   * nowego sha zawartości i commita.
   */
  async putFile(cfg: RepoConfig, text: string, sha: string | undefined, message: string): Promise<PutResult> {
    const path = this.contentsPath(cfg);
    const body: Record<string, string> = { message, content: toBase64(text), branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await this.request('PUT', path, { body });
    const json: unknown = await res.json().catch(() => null);
    if (
      !isRecord(json) ||
      !isRecord(json.content) ||
      typeof json.content.sha !== 'string' ||
      !isRecord(json.commit) ||
      typeof json.commit.sha !== 'string'
    ) {
      throw new GitHubError('invalid-response', 'GitHub nie potwierdził zapisu pliku. Dane lokalne pozostają oznaczone jako niezsynchronizowane.');
    }
    return { contentSha: json.content.sha, commitSha: json.commit.sha };
  }
}
