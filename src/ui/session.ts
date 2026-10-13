import { GitHubClient } from '../github/client';
import { MemoryTokenAuth } from '../github/auth';
import { OperationLock } from '../sync/lock';

/**
 * Obiekty sesji – żyją wyłącznie w pamięci karty. Po odświeżeniu strony są tworzone
 * od nowa, więc token znika (użytkownik wkleja go ponownie).
 */
export const auth = new MemoryTokenAuth();
export const githubClient = new GitHubClient(auth);
export const syncLock = new OperationLock();
