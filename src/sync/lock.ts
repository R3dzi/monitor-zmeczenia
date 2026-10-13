import { SyncError } from '../errors';

/** Blokada: ta sama operacja nie może działać równolegle. */
export class OperationLock {
  #busy = false;

  get busy(): boolean {
    return this.#busy;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new SyncError('busy', 'Inna operacja synchronizacji jest w toku.');
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
    }
  }
}
