# AlphaBot

## Co to jest AlphaBot

AlphaBot to osobisty asystent inwestycyjny dla rynku amerykańskiego (NYSE/NASDAQ), który codziennie rano skanuje wybrane sektory (tech, healthcare, fintech), wybiera 3 najciekawsze spółki i wysyła Ci gotowy briefing na telefon. Do analizy używa modelu Claude — screening liczbowy robi sam bot (yfinance), a Claude ocenia kandydatów, pisze uzasadnienia i śledzi ruchy znanych inwestorów (Buffett, Ackman, Burry) przez wyszukiwanie w internecie. Wszystko trzyma się w lokalnej bazie SQLite i pilnuje Twojego portfela — stop-lossy i maksymalny drawdown są monitorowane automatycznie w godzinach sesji.

## Wymagania

- **Python 3.11+**
- **Klucz API Anthropic** (Claude) — https://console.anthropic.com/settings/keys
- **Temat ntfy.sh** — dowolna unikalna nazwa, nie wymaga rejestracji (patrz sekcja Konfiguracja)
- Połączenie z internetem (yfinance, Claude API, ntfy.sh)

## Instalacja

```bash
git clone <adres-repo>   # albo po prostu wejdź do folderu alphabot/
cd alphabot

python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate

pip install -r requirements.txt
```

Skopiuj/uzupełnij plik `.env` w katalogu głównym (patrz niżej) i gotowe — baza SQLite (`alphabot.db`) tworzy się sama przy pierwszym uruchomieniu.

## Konfiguracja .env

```env
ANTHROPIC_API_KEY=tu_wklej_klucz
NTFY_TOPIC=tu_wklej_temat_z_ntfy
NTFY_URL=https://ntfy.sh
MONTHLY_BUDGET_USD=250
MAX_POSITIONS=5
MAX_DRAWDOWN_PCT=15
```

| Zmienna | Co wpisać | Gdzie to znaleźć |
|---|---|---|
| `ANTHROPIC_API_KEY` | Klucz API Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) → *Create Key*. Wymaga konta i doładowania (billing) |
| `NTFY_TOPIC` | Dowolna unikalna nazwa, np. `alphabot-jan-x7k2q` | Wymyślasz sam — im mniej oczywista nazwa, tym mniejsze ryzyko, że ktoś obcy ją odgadnie i zasubskrybuje (ntfy.sh publiczne tematy nie mają hasła). Zainstaluj apkę [ntfy](https://ntfy.sh/#subscribe-tips) (iOS/Android) i zasubskrybuj ten sam temat, żeby dostawać powiadomienia na telefon |
| `NTFY_URL` | `https://ntfy.sh` (domyślnie) | Zmień tylko jeśli hostujesz własny serwer ntfy |
| `MONTHLY_BUDGET_USD` | Miękki limit budżetu (informacyjny, nie egzekwowany automatycznie) | Twoja decyzja — patrz sekcja Koszty API niżej |
| `MAX_POSITIONS` | Maks. liczba otwartych pozycji, do których dąży strategia | Twoja decyzja |
| `MAX_DRAWDOWN_PCT` | Próg alertu "🛑 MAX DRAWDOWN" (% straty portfela od kosztu) | Twoja decyzja, domyślnie 15% |

Bez `ANTHROPIC_API_KEY` komendy `scan`/`research`/`gurus` nie zadziałają (rzucą czytelny błąd). Bez `NTFY_TOPIC` bot nie crashuje — powiadomienia po prostu drukują się w konsoli zamiast lecieć na telefon, więc możesz testować lokalnie bez konfigurowania ntfy.

## Komendy

| Komenda | Co robi | Przykład |
|---|---|---|
| `python main.py` | Startuje harmonogram: briefing 7:00 CET + monitoring stop-loss co godzinę w sesji (15:30-22:00 CET) | `python main.py` |
| `python main.py scan` | Odpala scanner ręcznie od razu, wynik idzie przez ntfy | `python main.py scan` |
| `python main.py research TICKER` | Głęboka analiza fundamentalna jednej spółki | `python main.py research AAPL` |
| `python main.py gurus` | Sprawdza ostatnie ruchy Buffetta/Ackmana/Burry'ego (web search) | `python main.py gurus` |
| `python main.py add TICKER SZTUKI CENA` | Dodaje pozycję do portfela | `python main.py add AAPL 2 185.50` |
| `python main.py deposit KWOTA` | Zapisuje wpłatę kapitału, liczy dostępne środki | `python main.py deposit 250` |
| `python main.py withdraw KWOTA` | Zapisuje wypłatę gotówki (blokada powyżej salda) | `python main.py withdraw 100` |
| `python main.py balance` | Pokazuje dostępny kapitał (wpłacono − zainwestowano) | `python main.py balance` |
| `python main.py portfolio` | Pełny P&L portfela: wpłaty, inwestycje, dostępne środki, drawdown | `python main.py portfolio` |
| `python main.py web` | Uruchamia lokalną aplikację webową (patrz sekcja niżej) | `python main.py web` |

## Aplikacja webowa

Lokalny panel do trackowania portfeli — bez logowania, tylko na Twoim komputerze:

```bash
python main.py web        # startuje serwer i otwiera http://localhost:8000
```

**Co potrafi:**

- **Dowolne portfele użytkownika** (np. osobne IKE/IKZE) w walutach USD/EUR/PLN/GBP — przełącznik
  u góry (wybór trzymany w URL), „+ Nowy portfel" tworzy kolejne; pusty portfel można usunąć przez API
- **Wykres wartości portfela w czasie** na dashboardzie — rekonstrukcja dzień po dniu z historii
  transakcji i wpłat (ceny historyczne + kursy FX z yfinance, forward-fill przez weekendy), z
  przerywaną linią wpłaconego kapitału netto — od razu widać kiedy portfel jest nad/pod wpłatami
- **Dashboard**: kafelki (wpłacono, gotówka, wartość pozycji, total P&L), tabela pozycji z kolorowanym zyskiem, historia wpłat
- **Szczegóły pozycji** (klik w wiersz tabeli): wykres ceny (linia/świece, zakresy 1M/3M/1R/MAX) z markerami transakcji — zielone kropki to otwarte pozycje, szare to zamknięte kupna i sprzedaże; pod wykresem lista otwartych pozycji z P&L każdego zakupu osobno oraz pełna historia transakcji ze zrealizowanym zyskiem
- **Transakcje BUY/SELL** z modala: autocomplete tickerów (Yahoo Finance), ułamkowe akcje, prowizje, walidacja "nie sprzedasz więcej niż masz"
- **Edycja i usuwanie transakcji**: menu ⋯ przy każdym wpisie w historii pozycji → Edytuj / Usuń
  (z potwierdzeniem). Usunięcie to twarde skasowanie błędnie wpisanej transakcji — to NIE sprzedaż,
  wpis znika z historii i wszystko się przelicza. Operacja jest blokowana, jeśli zostawiłaby
  w historii sprzedaż bez pokrycia (ujemny stan akcji w dowolnym momencie)
- **Waluty instrumentów**: przy transakcji zapisywana jest waluta notowania z yfinance; jeśli różni
  się od waluty portfela (np. DNP.WA w PLN w portfelu EUR), modal ostrzega, ale pozwala dodać —
  sumy portfela przeliczają takie pozycje po bieżącym kursie (cache 15 min) z adnotacją, że to
  przybliżenie. Nazwa spółki, giełda i badge Akcja/ETF pobierane są z yfinance przy pierwszej
  transakcji i cache'owane w tabeli `instruments`
- **Wpłaty i wypłaty** w walucie aktywnego portfela — wypłata nie może przekroczyć dostępnej
  gotówki; historia pokazuje oba typy (wypłaty na czerwono, z minusem), a każdy wpis można
  edytować/usunąć z menu ⋯ (blokada, jeśli operacja zostawiłaby ujemne saldo w historii)
- **Markery transakcji na wykresie** — zielone kropki (otwarte kupna), szare kropki (zamknięte),
  szare romby (sprzedaże), z obwódką i tooltipem na hover; przełączniki widoczności
  Kupno/Sprzedaż; markery dociągane do najbliższej sesji (weekend → piątek/poniedziałek)
- **Typy instrumentów**: badge Akcja/ETF/ETC przy pozycji; Yahoo często błędnie oznacza ETC,
  więc typ można nadpisać ręcznie (szczegóły pozycji → ⋯ → „Zmień typ instrumentu")
- **Odporność na braki danych**: ceny NaN/brakujące z yfinance nigdy nie wywalają API — pozycja bez
  wyceny liczy się do sumy po koszcie zakupu, z adnotacją "cena niedostępna"

**Model danych:** pozycje nie są przechowywane wprost — wyliczają się z historii transakcji.
Sprzedaże rozliczane są metodą **FIFO** (najstarsze loty schodzą pierwsze), a zysk zrealizowany
i niezrealizowany liczony jest netto po prowizjach. Gotówka portfela = wpłaty − (zakupy + prowizje)
+ (sprzedaże − prowizje). Stare pozycje i wpłaty (sprzed wersji webowej) migrują się automatycznie
do portfela USD przy pierwszym uruchomieniu.

**Frontend** (React + Vite + lightweight-charts) jest zbudowany do `web/frontend/dist` i serwowany
przez FastAPI — do zwykłego użytku nie potrzebujesz Node. Jeśli chcesz go rozwijać:

```bash
cd web/frontend
npm install
npm run dev      # dev server z proxy do API na :8000
npm run build    # przebudowa dist/ serwowanego przez python main.py web
```

**Testy** (FIFO, gotówka, walidacja sprzedaży, migracja, e2e przez API):

```bash
.venv/bin/python -m pytest tests/
```

## Jak to działa w praktyce

**Codzienny workflow wygląda mniej więcej tak:**

1. **7:00 CET** — telefon brzęczy: "📊 Morning Briefing". W środku top 3 sygnały (ticker, powód, strefa wejścia, stop-loss, target), krótki komentarz rynkowy (S&P 500, VIX) i aktualizacja P&L jeśli masz otwarte pozycje.
2. **Rano/w ciągu dnia** — patrzysz na sygnały. Jeśli coś Cię przekonuje, odpalasz `python main.py research TICKER`, żeby dostać głębszą analizę fundamentalną przed decyzją.
3. **Decydujesz** — jeśli wchodzisz w pozycję, najpierw `python main.py deposit KWOTA` (jeśli dopłacasz kapitał), potem `python main.py add TICKER SZTUKI CENA` po faktycznym zakupie u brokera (AlphaBot nie handluje za Ciebie — tylko śledzi).
4. **W ciągu dnia sesji (15:30-22:00 CET)** — bot co godzinę cicho sprawdza Twoje pozycje. Jeśli któraś spadnie ≥8% od zakupu, dostajesz pilny alert "⚠️ STOP LOSS ALERT". Jeśli cały portfel spadnie powyżej `MAX_DRAWDOWN_PCT`, dostajesz "🛑 MAX DRAWDOWN" — to sygnał do przemyślenia całej strategii, nie tylko jednej pozycji.
5. **Kiedy chcesz** — `python main.py gurus` (co śledzą Buffett/Ackman/Burry) albo `python main.py portfolio` / `balance`, żeby sprawdzić stan konta.

AlphaBot nigdy nie składa zleceń automatycznie — to narzędzie do sygnałów i monitoringu, decyzje i egzekucja zawsze są po Twojej stronie.

## Koszty API

Bot używa modelu **Claude Sonnet 5** (`claude-sonnet-5`) — świadomy wybór zamiast droższego Opusa, bo przy codziennym, częstym odpytywaniu koszt ma znaczenie, a Sonnet 5 daje jakość bardzo bliską Opusowi za ułamek ceny. Aktualny cennik (promocyjny do 2026-08-31): $2/1M tokenów input, $10/1M tokenów output.

Przy typowym użyciu (1 poranny briefing dziennie + kilka `research`/`gurus` tygodniowo):

| Komponent | Częstotliwość | Szacunkowy koszt/miesiąc |
|---|---|---|
| Morning briefing / `scan` | 1x dziennie | ~$0.30-0.50 |
| `research TICKER` | kilka-kilkanaście razy/miesiąc | ~$0.10-0.30 |
| `gurus` (web search, droższe — wyszukiwania to $10/1000 zapytań + tokeny thinkingu) | kilka razy/tydzień | ~$2-4 |
| Monitoring stop-loss (co godzinę w sesji) | codziennie w dni sesyjne | **$0** — to czysta logika na danych z yfinance, żadnych wywołań Claude |

**Razem: realistycznie kilka do kilkunastu dolarów miesięcznie** przy normalnym użyciu domowym. `MONTHLY_BUDGET_USD=250` w `.env` to bezpieczny, hojny limit informacyjny (nie jest dziś nigdzie automatycznie egzekwowany w kodzie) — realny koszt powinien być wielokrotnie niższy, chyba że zaczniesz odpalać `gurus`/`research` bardzo często. yfinance i ntfy.sh (publiczny serwer) są całkowicie darmowe.
