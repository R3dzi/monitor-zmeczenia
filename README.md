# Monitor zmęczenia (PWA) – ręczna synchronizacja z prywatnym GitHubem

Aplikacja do codziennego monitorowania zmęczenia: **HRV, Body Battery, SSZ, Morning Run Test**, kolor dnia, historia, wykres z ostatnich 7 dni, eksport/import JSON i CSV. Wszystkie funkcje pomiarowe działają **lokalnie i offline** (IndexedDB przez Dexie). Synchronizacja z prywatnym repozytorium GitHub jest **opcjonalna i wyłącznie ręczna**.

> **Status synchronizacji:** logika została przetestowana automatycznie na symulatorze GitHub Contents API (41 testów). **Nie była jeszcze przetestowana na prawdziwym prywatnym repozytorium** – traktuj ją jako niezweryfikowaną, dopóki nie wykonasz „Testu na prawdziwym repozytorium” opisanego niżej.

> **Ważne – reguły ocen są przykładowe.** Kod pierwotnej aplikacji nie był dostępny, więc progi zaliczenia testów i mapowanie koloru dnia (`src/rules.config.ts`) to wartości tymczasowe (HRV ≥ 50, Body Battery ≥ 50, SSZ ≤ 4 w skali 1–10, Morning Run: średnie HR ≤ 150 i dryf ≤ 8). Podmień je na własne reguły – to jedyne miejsce do zmiany, następnie ustaw `PLACEHOLDER: false`. Format `data.json` i synchronizacja nie zależą od tych progów (status i kolor są zawsze wyliczane z surowych wartości).

## Uruchomienie lokalne

```bash
npm install
npm run dev        # serwer deweloperski
npm test           # 41 testów + budowa i kontrola plików dist
npm run build      # typecheck + build produkcyjny do ./dist
npm run preview    # podgląd builda (tu działa Service Worker)
```

Wymagany Node.js 20+ (testowano na 22).

## Wdrożenie frontendu na GitHub Pages

1. Utwórz **publiczne** repozytorium na kod aplikacji (np. `monitor-zmeczenia`) i wypchnij ten katalog na gałąź `main`.
   Repozytorium z kodem **nie może zawierać pomiarów** (`data.json` jest w `.gitignore`).
2. W repozytorium: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Workflow `.github/workflows/deploy.yml` uruchomi się po pushu: zainstaluje zależności, uruchomi typecheck i testy (w tym kontrolę, że w buildzie nie ma tokenu ani danych), po czym opublikuje `dist/`.
4. Aplikacja będzie pod adresem `https://<użytkownik>.github.io/<repo>/`. Ścieżki są względne, więc nie trzeba nic konfigurować.
5. Otwórz adres na telefonie i „Dodaj do ekranu głównego”. Po pierwszym załadowaniu aplikacja działa offline.

## Prywatne repozytorium na dane

1. GitHub → **New repository** → nazwa np. `zmeczenie-dane` → **Private** (obowiązkowo).
2. Może być puste. Plik `data.json` zostanie utworzony przy pierwszej synchronizacji (gałąź `main` musi istnieć – zaznacz „Add a README file” przy tworzeniu, jeśli repozytorium jest puste).
3. To repozytorium jest **oddzielone** od repozytorium z kodem. Nie włączaj w nim GitHub Pages.

## Token (fine-grained Personal Access Token)

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** Twoje konto. **Expiration:** krótki termin (np. 30–90 dni).
3. **Repository access → Only select repositories →** wybierz *wyłącznie* repozytorium z danymi.
4. **Permissions → Repository permissions → Contents: Read and write** (pozostałe zostaw bez dostępu; *Metadata: Read* dodaje się automatycznie).
5. Skopiuj token i wklej go w aplikacji: **Ustawienia → Połącz z GitHubem** (pola: właściciel, nazwa repozytorium, ścieżka `data.json`, gałąź `main`) → **Sprawdź połączenie**.

Aplikacja odmówi pracy z repozytorium **publicznym** oraz z tokenem bez prawa zapisu.

**Token po odświeżeniu strony trzeba wkleić ponownie** – to zamierzone. Trzymany jest wyłącznie w pamięci karty (prywatne pole klasy), a nie w localStorage, IndexedDB, Cache Storage ani Service Workerze. Nigdy nie jest wysyłany nigdzie poza `api.github.com`. Dodatkowo CSP w buildzie (`connect-src 'self' https://api.github.com`) blokuje połączenia do innych hostów.

## Jak działa synchronizacja

Trzy przyciski (Ustawienia → Synchronizacja): **Synchronizuj** (w obie strony), **Pobierz** (tylko do urządzenia), **Wyślij** (tylko na GitHub). Zawsze:

1. pobierany i walidowany jest aktualny plik z GitHuba (uszkodzony plik jest odrzucany, nic nie jest nadpisywane),
2. widzisz **podsumowanie** (ile rekordów w którą stronę, ile identycznych, konflikty) i dopiero wtedy zatwierdzasz,
3. zapis na GitHubie idzie z aktualnym `sha`; po konflikcie wersji plik jest pobierany ponownie i scalanie zaczyna się od początku,
4. rekordy oznaczane są jako zsynchronizowane **dopiero po potwierdzeniu zapisu przez serwer**.

Scalanie po dacie, trójstronne (z zapamiętaną wersją z ostatniej synchronizacji): rekordy tylko po jednej stronie są dodawane; identyczne zostają; zmiana po jednej stronie – wygrywa strona, która się zmieniła; zmiana po obu stronach (lub brak bazy do porównania) – **konflikt**, który rozstrzygasz ręcznie (wersja lokalna / z GitHuba). Reguła „ostatni zapis wygrywa” nie jest stosowana. **Scalanie nigdy nie usuwa rekordów**, a pusty plik na GitHubie nie zastępuje danych lokalnych. Synchronizacja nigdy nie startuje sama – także po odzyskaniu internetu.

Format pliku (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-13T10:00:00.000Z",
  "measurements": [
    {
      "date": "2026-10-13",
      "hrv": 62, "bodyBattery": 74, "ssz": 3,
      "morningRun": { "pace": 330, "hr": [120,125,128,130,132,134,136,138,140,141] },
      "notes": "opcjonalnie",
      "modifiedAt": "2026-10-13T06:45:00.000Z"
    }
  ]
}
```

`pace` to sekundy na kilometr. Status testów, liczba zaliczonych i kolor dnia **nie są zapisywane** – są wyliczane przy odczycie; pola spoza schematu są ignorowane.

## Test na prawdziwym repozytorium (zanim zaufasz synchronizacji)

1. Połącz aplikację z pustym, prywatnym repozytorium testowym i zapisz 2 pomiary → **Synchronizuj** → sprawdź na GitHubie, czy powstał `data.json` (dwa rekordy).
2. Zmień plik ręcznie na GitHubie (np. dodaj rekord z innej daty) → **Synchronizuj** → rekord pojawi się w historii.
3. Zmień ten sam dzień lokalnie i na GitHubie → powinien pojawić się konflikt z wyborem wersji.
4. Odśwież stronę → status „niepołączono”; wklej token ponownie → synchronizacja działa bez duplikatów.
5. Ustaw token z wygasłą datą / bez dostępu do repo i sprawdź komunikaty błędów.

## Struktura kodu

| Plik | Rola |
|---|---|
| `src/rules.config.ts` | **progi ocen i kolory dnia (do podmiany)** |
| `src/validate.ts`, `src/evaluate.ts` | walidacja JSON/zakresów, wyliczanie statusów |
| `src/db.ts`, `src/store.ts` | Dexie/IndexedDB, zapis offline, konfiguracja (bez tokenu) |
| `src/merge.ts` | scalanie trójstronne i konflikty |
| `src/github/auth.ts` | `AuthProvider` + token wyłącznie w pamięci (do zastąpienia backendem z GitHub App) |
| `src/github/client.ts` | GitHub Contents API (GET/PUT, sha, Base64, obsługa 401/403/404/409/422/5xx, limity) |
| `src/sync/*` | plan → podsumowanie → wykonanie, blokada równoległych operacji |
| `src/importExport.ts` | eksport/import JSON i CSV z walidacją i podsumowaniem zmian |
| `public/sw.js`, `public/manifest.webmanifest` | działanie offline i instalacja PWA |

## Ograniczenia

- Prywatne repozytorium GitHub jest **kopią danych, a nie szyfrowaną bazą medyczną**. Aplikacja nie ma telemetrii.
- Usuwanie pomiarów nie jest obsługiwane (scalanie nigdy nie kasuje rekordów, więc usunięcie byłoby cofane przy synchronizacji).
- Pliki powyżej ok. 1 MB są obsługiwane przez pobranie „raw”, ale nie były testowane na prawdziwym API.
