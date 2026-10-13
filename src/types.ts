export interface MorningRun {
  /** Tempo w sekundach na kilometr (np. 330 = 5:30/km) lub null, gdy nie zmierzono. */
  pace: number | null;
  /** Dokładnie 10 pomiarów tętna (null = brak pomiaru). */
  hr: (number | null)[];
}

/** Rekord dzienny – dokładnie to, co trafia do pliku data.json. */
export interface Measurement {
  /** YYYY-MM-DD */
  date: string;
  hrv: number | null;
  bodyBattery: number | null;
  ssz: number | null;
  morningRun: MorningRun;
  notes?: string;
  /** ISO-8601; czas ostatniej modyfikacji rekordu. */
  modifiedAt: string;
}

/** Rekord w IndexedDB: pomiar + metadane synchronizacji (nie trafiają do JSON). */
export interface LocalMeasurement extends Measurement {
  /** 1 = zmiany lokalne oczekują na synchronizację. */
  dirty: 0 | 1;
  /**
   * Zawartość rekordu (postać kanoniczna) zapisana na GitHubie przy ostatniej
   * udanej synchronizacji. Pozwala rozstrzygnąć, po której stronie wystąpiła zmiana.
   */
  syncedBase: string | null;
}

export interface DataFile {
  schemaVersion: 1;
  updatedAt: string;
  measurements: Measurement[];
}

export interface RepoConfig {
  owner: string;
  repo: string;
  path: string;
  branch: string;
}

export const DEFAULT_CONFIG: RepoConfig = {
  owner: '',
  repo: '',
  path: 'data.json',
  branch: 'main',
};
