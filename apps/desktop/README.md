# @stubwise/desktop

L'interfaccia nuova di Stubwise (Electron + React 19 + Vite): un renderer
solo, tre build. Nato come prototipo cliccabile **completo** (aree 1–11,
provate a mano dal maintainer ed entrate in `main` con la PR #122, 9 nov
2026); dall'integrazione dell'area 2 (fetta 1, stesso giorno,
`docs/plans/2026-11-09-integrazione-area2-task-design.md`) gira anche
contro il server vero:

| Build | Dati | Dove | Login |
|---|---|---|---|
| `prototype` | finti, in memoria | `dev`, `preview:web`, i test | nessuno («View as») |
| `app` desktop | server vero | Electron, dmg locale non firmato (`package:mac`) | dal browser di sistema |
| `app` web | server vero | SPA su `/app`, servita da caddy | cookie di sessione del web |

Il modo lo sceglie `STUBWISE_BUILD` (default `prototype`): `vite.backend.ts`
risolve `@backend/api` e `@backend/clock` sull'implementazione finta
(`src/renderer/data/api.ts`, `data/seed/dates.ts`) o su quella vera
(`src/renderer/data/backend/real/`, sopra `@stubwise/api-client`). Nelle
build «app» le aree non ancora integrate restano nella navigazione «in
arrivo» (`data/integration.ts`).

Il prototipo **è la specifica** dell'app vera: ogni pagina è definita fino in
fondo, con dati finti realistici. Chi lo sviluppa davvero (server, API) parte
da qui, non dal web: `apps/web` e `apps/mobile` NON sono un riferimento per
questa app (`PRODUCT.md`).

## Avvio

```
pnpm --filter @stubwise/desktop dev          # finestra Electron
pnpm --filter @stubwise/desktop preview:web  # il solo renderer in un browser (http://localhost:5174)
pnpm --filter @stubwise/desktop test         # ~6700 test, 6–8 minuti
pnpm --filter @stubwise/desktop typecheck

# Build «app» (server vero)
STUBWISE_BUILD=app pnpm --filter @stubwise/desktop dev   # Electron contro l'istanza scelta al primo avvio
pnpm --filter @stubwise/desktop build:web                # la SPA per /app (in dist-web/), come in Dockerfile.caddy
node apps/desktop/scripts/check-no-seed.mjs apps/desktop/dist-web   # nessun dato del seed nel bundle
pnpm --filter @stubwise/desktop package:mac              # .dmg locale non firmato in release/
```

`package:mac` builda in modo «app» e impacchetta con `electron-builder.yml`:
niente firma, notarizzazione né auto-update (non obiettivi), e il protocollo
`stubwise://` registrato nel pacchetto. Al primo avvio si sceglie l'indirizzo
dell'istanza; il **login passa dal browser di sistema** (passkey compresa):
l'app apre `<istanza>/app/#/desktop-login` con un challenge PKCE, il browser
dopo il login e «Allow» riapre l'app con `stubwise://auth?code=…&state=…`, e
il main scambia il codice col suo token (`src/main/browserLogin.ts`,
`POST /api/auth/desktop-exchange`). Il token sta nel Keychain
(`safeStorage`, `src/main/session.ts`) e non arriva mai al renderer.

Electron scarica il suo binario all'install: `electron` sta in
`pnpm.onlyBuiltDependencies` nel `package.json` della radice. Se
`node_modules/electron/dist` manca, lancia `node node_modules/electron/install.js`
da `apps/desktop`. In CI il binario non si scarica (`ELECTRON_SKIP_BINARY_DOWNLOAD`):
i test girano in happy-dom, nel job «Test resto».

## Provarlo a mano

- **I dati sono in memoria**: riavviare l'app li azzera tutti.
- Si entra come **Giulia Ferri** (Project Lead), che però non è membro di
  tutti i progetti. Per vedere un'altra persona: ⌘K → «View as». Le persone
  delle prove: **Laura Costa** (Project Lead di ACQ, che ha le 9 pagine di
  prodotto), **Marco Bellini** (Developer), **Sara Montanari** (Contributor,
  sola lettura). VRD ha lo spazio di prodotto vuoto, apposta.
- L'esito delle prove a mano del maintainer è in
  `docs/ossatura-follow-ups.md` (sezione «Esiti»).

## Dove stanno le decisioni

Ogni scelta di prodotto è del maintainer, presa con una domanda a scelta
multipla e scritta con la sua data. Prima di cambiare una pagina, leggi:

| Cosa | Dove |
|---|---|
| Prodotto, utenti, tono | `PRODUCT.md` |
| Stile visivo e componenti | `DESIGN.md`; direction contract in `.impeccable/surfaces/src-renderer.md` |
| Design di un'area (con le «Decisioni del maintainer») | `docs/plans/2026-1x-xx-desktop-<area>-design.md` alla radice del repo |
| Piano di un'area (cosa è stato costruito, task per task) | `docs/plans/2026-1x-xx-desktop-<area>-plan.md` |
| Regole di una schermata (stati, testi, tasti) | `.impeccable/shape/<schermata>.md` (59 file) |
| Decisioni prese strada facendo, minori aperti, limiti scelti | `docs/ossatura-follow-ups.md`, una sezione per area |
| Cosa corrisponde al web, e cosa no di proposito | `docs/areaN-parity.md` |

Le aree: 1 ossatura · 2 task · 3 Claude · 4 chat · 5 docs e Drive · 6 posta e
calendario · 7 automazioni · 8 rilasci, assistenza e server (8a, 8b) · 9
amministrazione (9a, 9b, 9c) · 10 integrazione di Claude (10a, 10b) · 11
documentazione di prodotto (11a, 11b).

## Regole fisse

- Ogni testo esiste in `en` e in `it` (`src/renderer/i18n/locales/`); i test
  lo controllano.
- Il carattere a spaziatura fissa si usa solo col token `font-code` (eccezione
  dichiarata per il codice); `font-mono` è il sans.
- Il controllo design di Impeccable (`.impeccable/config.json` di questa
  cartella) gira sulle modifiche alla UI: un'eccezione si aggiunge lì, con il
  motivo, mai a tutto il progetto.
- I permessi vengono da `@stubwise/shared`: un permesso nuovo lì va messo in un
  gruppo (`domain/access/actions.ts`) con nome e frase nelle due lingue, o i
  test falliscono.

## Cosa è finto

Nella build `prototype`, tutto: i dati (task, progetti, chat, calendario,
automazioni, pagine di prodotto) sono fixture locali in
`src/renderer/data/seed/`, nessuna chiamata di rete, nessun server Stubwise.
Nelle build «app» il seed non c'è (`scripts/check-no-seed.mjs` fa fallire il
build se ne trova un nome), e le letture e scritture delle aree integrate
vanno al server; quelle delle aree non integrate rifiutano con
`NotIntegratedError` (`data/backend/real/stubs.generated.ts`, rigenerato con
`pnpm --filter @stubwise/desktop gen:stubs`).

Il preload espone `window.stubwise = { platform, setTheme, onMenu, saveFile,
api, instance, session, openWeb }`, sempre con funzioni strette (mai
`ipcRenderer` né canali scelti dal renderer, mai il token): `api.request`
passa una richiesta al main, che aggiunge il bearer; `instance` legge e
scrive l'indirizzo dell'istanza; `session` avvia e annulla il login dal
browser (`startBrowserLogin`, `cancelBrowserLogin`), ne riceve l'esito
(`onChanged`), fa logout e dice lo stato (`login` con password è deprecato e
risponde sempre `use_browser_login`); `openWeb` apre una pagina del web
vecchio nel browser. Il renderer non richiede alcuna API Electron per
renderizzare: nel browser (`preview:web`, `/app`) `window.stubwise` manca.

## Sicurezza della finestra

`sandbox`, `contextIsolation`, niente `nodeIntegration`. In più (`src/main/index.ts`,
logica pura in `src/main/security.ts`):

- `setWindowOpenHandler` nega sempre; i link http(s) si aprono nel browser di
  sistema con `shell.openExternal`, ogni altro schema è scartato.
- `will-navigate` è bloccato salvo verso l'origine del dev server
  (`ELECTRON_RENDERER_URL`) o verso l'`index.html` impacchettato.
- CSP (`PRODUCTION_CSP`) iniettata come `<meta>` solo nel build (plugin in
  `electron.vite.config.ts`): il renderer impacchettato è `file://`, dove non
  ci sono header, e in dev HMR vuole script inline. `preview:web` non la usa.

## Screenshot per la revisione visiva

`node apps/desktop/scripts/capture.mjs` avvia (o riusa) `preview:web` e salva
le schermate in `.impeccable/review/` (ignorata da git). Serve Chromium di
Playwright (`pnpm exec playwright install chromium`).

La direzione visiva («Catalogo numerato») è nel direction contract di
`.impeccable/surfaces/src-renderer.md` e nello spec
`docs/plans/2026-10-23-desktop-ossatura-design.md`.
