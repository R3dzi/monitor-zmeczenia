import Dexie, { type Table } from 'dexie';
import type { LocalMeasurement } from './types';

export interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * Lokalna baza. UWAGA: tabela `meta` przechowuje wyłącznie ustawienia niesekretne
 * (właściciel/nazwa repo, ścieżka, gałąź, czas ostatniej synchronizacji).
 * Token GitHub NIGDY tu nie trafia.
 */
export class FatigueDB extends Dexie {
  measurements!: Table<LocalMeasurement, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = 'monitor-zmeczenia') {
    super(name);
    this.version(1).stores({
      measurements: 'date, dirty, modifiedAt',
      meta: 'key',
    });
  }
}

export const db = new FatigueDB();
