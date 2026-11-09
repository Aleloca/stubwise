# @stubwise/desktop

Prototipo desktop di Stubwise (Electron + React 19 + Vite): solo l'ossatura
della shell. Non fa parte di nessun deploy.

## Avvio

```
pnpm --filter @stubwise/desktop dev          # finestra Electron
pnpm --filter @stubwise/desktop preview:web  # il solo renderer in un browser (http://localhost:5174)
pnpm --filter @stubwise/desktop test
pnpm --filter @stubwise/desktop typecheck
```

Electron scarica il suo binario all'install: `electron` sta in
`pnpm.onlyBuiltDependencies` nel `package.json` della radice. Se
`node_modules/electron/dist` manca, lancia `node node_modules/electron/install.js`
da `apps/desktop`.

## Cosa è finto

Tutto. I dati (task, progetti, chat, calendario, automazioni) sono fixture
locali; nessuna chiamata di rete, nessun server Stubwise. Il preload espone
`window.stubwise = { platform, setTheme, onMenu }` (tema risolto verso il
main, eventi del menu verso il renderer; mai `ipcRenderer` né canali scelti
dal renderer), e il renderer non richiede alcuna API Electron per renderizzare.

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
