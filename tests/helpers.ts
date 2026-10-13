import { FatigueDB } from '../src/db';
import { MemoryTokenAuth } from '../src/github/auth';
import { GitHubClient, fromBase64, toBase64 } from '../src/github/client';
import type { SyncContext } from '../src/sync/syncService';
import { DEFAULT_CONFIG, type Measurement, type RepoConfig } from '../src/types';
import { saveMeasurement } from '../src/store';

export const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2);
export const CONFIG: RepoConfig = { ...DEFAULT_CONFIG, owner: 'jan', repo: 'dane-zmeczenie' };

interface FakeFile {
  text: string;
  sha: string;
}

/** Minimalny symulator GitHub Contents API (z semantyką sha, 401, 409, 422). */
export class FakeGitHub {
  files = new Map<string, FakeFile>();
  validToken = TOKEN;
  isPrivate = true;
  canPush = true;
  networkDown = false;
  failNextPut: number | null = null;
  /** Wywoływane tuż przed obsługą PUT – pozwala zasymulować zmianę pliku przez inne urządzenie. */
  beforePut: (() => void) | null = null;
  requests: { method: string; url: string; host: string; hasSha: boolean; auth: string | null }[] = [];
  private counter = 0;

  key(cfg: RepoConfig = CONFIG) {
    return `${cfg.owner}/${cfg.repo}/${cfg.branch}/${cfg.path}`;
  }

  /** Ustawia plik „po stronie GitHuba” (jak commit z innego urządzenia). */
  setFile(text: string, cfg: RepoConfig = CONFIG) {
    this.files.set(this.key(cfg), { text, sha: `sha${++this.counter}` });
  }

  getText(cfg: RepoConfig = CONFIG): string | undefined {
    return this.files.get(this.key(cfg))?.text;
  }

  getSha(cfg: RepoConfig = CONFIG): string | undefined {
    return this.files.get(this.key(cfg))?.sha;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.networkDown) throw new TypeError('Failed to fetch');
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    this.requests.push({ method, url: input, host: url.host, hasSha: !!body?.sha, auth: headers.Authorization ?? null });

    if (headers.Authorization !== `Bearer ${this.validToken}`) return this.json(401, { message: 'Bad credentials' });

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repoMatch && method === 'GET') {
      if (repoMatch[1] !== CONFIG.owner || repoMatch[2] !== CONFIG.repo) return this.json(404, { message: 'Not Found' });
      return this.json(200, { private: this.isPrivate, permissions: { push: this.canPush } });
    }

    const m = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (!m) return this.json(404, { message: 'Not Found' });
    const cfg: RepoConfig = {
      owner: m[1],
      repo: m[2],
      path: decodeURIComponent(m[3]),
      branch: method === 'GET' ? (url.searchParams.get('ref') ?? 'main') : String(body?.branch ?? 'main'),
    };
    const file = this.files.get(this.key(cfg));

    if (method === 'GET') {
      if (!file) return this.json(404, { message: 'Not Found' });
      const wrapped = toBase64(file.text).replace(/(.{60})/g, '$1\n');
      return this.json(200, { type: 'file', encoding: 'base64', size: file.text.length, sha: file.sha, content: wrapped });
    }

    if (method === 'PUT') {
      this.beforePut?.();
      if (this.failNextPut !== null) {
        const status = this.failNextPut;
        this.failNextPut = null;
        return this.json(status, { message: 'Server Error' });
      }
      const current = this.files.get(this.key(cfg));
      if (current && !body?.sha) return this.json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      if (current && body?.sha !== current.sha) return this.json(409, { message: `${cfg.path} does not match ${body?.sha}` });
      if (!current && body?.sha) return this.json(422, { message: 'Invalid request. "sha" is not allowed for a new file.' });
      const text = fromBase64(String(body?.content));
      const sha = `sha${++this.counter}`;
      this.files.set(this.key(cfg), { text, sha });
      return this.json(current ? 200 : 201, { content: { sha }, commit: { sha: `commit${this.counter}` } });
    }
    return this.json(405, { message: 'Method not allowed' });
  };
}

let dbCounter = 0;

export function makeCtx(overrides: Partial<{ fake: FakeGitHub; db: FatigueDB; auth: MemoryTokenAuth }> = {}) {
  const fake = overrides.fake ?? new FakeGitHub();
  const db = overrides.db ?? new FatigueDB(`test-db-${++dbCounter}-${Math.random().toString(36).slice(2)}`);
  const auth = overrides.auth ?? new MemoryTokenAuth();
  if (!overrides.auth) auth.setToken(TOKEN);
  const client = new GitHubClient(auth, fake.fetch);
  const ctx: SyncContext = { db, client, config: CONFIG, now: () => new Date('2026-10-13T10:00:00.000Z') };
  return { fake, db, auth, client, ctx };
}

export function rec(date: string, over: Partial<Measurement> = {}): Measurement {
  return {
    date,
    hrv: 60,
    bodyBattery: 70,
    ssz: 3,
    morningRun: { pace: 330, hr: [120, 125, 128, 130, 132, 134, 136, 138, 140, 141] },
    modifiedAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}

export function remoteFile(records: Measurement[]): string {
  return JSON.stringify({ schemaVersion: 1, updatedAt: '2026-10-01T09:00:00.000Z', measurements: records }, null, 2);
}

/** Zapis lokalny przez publiczne API aplikacji (dirty = 1). */
export async function saveLocal(db: FatigueDB, m: Measurement, now = new Date('2026-10-10T08:00:00.000Z')) {
  const { modifiedAt: _ignored, ...input } = m;
  void _ignored;
  return saveMeasurement(db, input, now);
}
