/**
 * Warstwa autoryzacji. Klient GitHub zna wyłącznie ten interfejs, więc w przyszłości
 * można go zastąpić implementacją opartą o backend z GitHub App i krótkotrwałymi
 * tokenami (instalacyjnymi) bez zmian w reszcie aplikacji.
 */
export interface AuthProvider {
  /** Wartość nagłówka Authorization albo null, gdy użytkownik nie jest uwierzytelniony. */
  getAuthorizationHeader(): string | null;
  isAuthenticated(): boolean;
  /** Wylogowanie – usuwa poświadczenia z pamięci. */
  clear(): void;
}

const TOKEN_RE = /^[\x21-\x7E]{20,255}$/;

/**
 * Token osobisty (fine-grained PAT) trzymany WYŁĄCZNIE w pamięci tego obiektu
 * (prywatne pole klasy). Nie jest zapisywany w localStorage, sessionStorage,
 * IndexedDB, Cache Storage ani w Service Workerze; znika po przeładowaniu strony.
 */
export class MemoryTokenAuth implements AuthProvider {
  #token: string | null = null;

  setToken(raw: string): void {
    const t = raw.trim();
    if (!TOKEN_RE.test(t)) {
      throw new Error('Token ma nieprawidłowy format (puste pole, spacje lub niedozwolone znaki).');
    }
    this.#token = t;
  }

  getAuthorizationHeader(): string | null {
    return this.#token ? `Bearer ${this.#token}` : null;
  }

  isAuthenticated(): boolean {
    return this.#token !== null;
  }

  clear(): void {
    this.#token = null;
  }

  /** Używane przez klienta wyłącznie do wycinania tokenu z ewentualnych komunikatów. */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join('[token]') : text;
  }

  // Zabezpieczenie przed przypadkowym zserializowaniem lub zalogowaniem obiektu.
  toJSON(): string {
    return '[MemoryTokenAuth]';
  }
  toString(): string {
    return '[MemoryTokenAuth]';
  }
}
