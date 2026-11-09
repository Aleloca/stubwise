# @stubwise/desktop

Prototipo cliccabile dell'app desktop di Stubwise (Electron + React 19 +
Vite), **completo**: aree 1–11, provate a mano dal maintainer ed entrate in
`main` con la PR #122 (9 nov 2026). Non fa parte di nessun deploy.

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
```

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

Tutto. I dati (task, progetti, chat, calendario, automazioni, pagine di
prodotto) sono fixture locali in `src/renderer/data/seed/`; nessuna chiamata
di rete, nessun server Stubwise. Il preload espone `window.stubwise = {
platform, setTheme, onMenu, saveFile }` (mai `ipcRenderer` né canali scelti dal
renderer), e il renderer non richiede alcuna API Electron per renderizzare.

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
