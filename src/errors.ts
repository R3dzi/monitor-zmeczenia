export type GitHubErrorKind =
  | 'no-token'
  | 'invalid-config'
  | 'auth'
  | 'forbidden'
  | 'ratelimit'
  | 'notfound'
  | 'repo-not-found'
  | 'branch-missing'
  | 'conflict'
  | 'validation'
  | 'server'
  | 'network'
  | 'invalid-response';

/** Błąd komunikacji z GitHubem. Komunikat NIGDY nie zawiera tokenu ani nagłówków. */
export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status?: number;
  readonly resetAt?: Date;
  constructor(kind: GitHubErrorKind, message: string, opts: { status?: number; resetAt?: Date } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = opts.status;
    this.resetAt = opts.resetAt;
  }
}

export type SyncErrorKind = 'invalid-remote' | 'unresolved-conflicts' | 'too-many-retries' | 'busy' | 'not-connected';

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.name = 'SyncError';
    this.kind = kind;
  }
}

export class ValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** Komunikat bezpieczny do pokazania użytkownikowi (nieznane błędy są zastępowane ogólnym tekstem). */
export function safeErrorMessage(e: unknown): string {
  if (e instanceof GitHubError || e instanceof SyncError || e instanceof ValidationError) return e.message;
  return 'Wystąpił nieoczekiwany błąd. Dane lokalne nie zostały zmienione.';
}
