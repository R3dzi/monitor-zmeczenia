/**
 * ============================================================================
 *  UWAGA: WARTOŚCI PRZYKŁADOWE (PLACEHOLDERY)
 * ============================================================================
 * Kod istniejącej aplikacji nie był dostępny, więc progi oceny testów i mapowanie
 * kolorów dnia poniżej to wartości TYMCZASOWE. Zastąp je własnymi regułami
 * z oryginalnej aplikacji. To jedyne miejsce, które trzeba zmienić – cała reszta
 * (UI, synchronizacja, walidacja) czyta reguły stąd.
 *
 * Zakresy `limits` służą wyłącznie do walidacji danych (odrzucenia wartości
 * niemożliwych), a nie do oceny wyniku.
 * ============================================================================
 */
export const RULES = {
  /** Flaga informacyjna – pokazuje w ustawieniach, że reguły są przykładowe. Ustaw na false po podmianie. */
  PLACEHOLDER: true,

  /** Zakresy poprawności danych wejściowych (walidacja, nie ocena). */
  limits: {
    hrv: { min: 1, max: 300 }, // ms
    bodyBattery: { min: 0, max: 100 },
    ssz: { min: 1, max: 10 }, // PRZYKŁAD: skala 1–10
    pace: { min: 120, max: 1200 }, // s/km (2:00–20:00)
    hr: { min: 30, max: 240 }, // bpm
  },

  /** Progi zaliczenia poszczególnych testów. */
  thresholds: {
    hrv: { min: 50 }, // zalicza się, gdy HRV >= min
    bodyBattery: { min: 50 }, // zalicza się, gdy BB >= min
    ssz: { max: 4 }, // zalicza się, gdy SSZ <= max
    morningRun: {
      maxAvgHr: 150, // średnie tętno z 10 pomiarów <= maxAvgHr
      maxDrift: 8, // (średnia z 5 ostatnich) - (średnia z 5 pierwszych) <= maxDrift
    },
  },

  /** Kolor dnia wg liczby zaliczonych testów (sprawdzane od góry). */
  colors: [
    { minPassed: 4, color: 'green' },
    { minPassed: 3, color: 'yellow' },
    { minPassed: 2, color: 'orange' },
    { minPassed: 0, color: 'red' },
  ] as const,
} as const;
