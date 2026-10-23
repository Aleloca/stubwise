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
solo `window.stubwise = { platform }`, e il renderer non richiede alcuna API
Electron per renderizzare.

La direzione visiva («Catalogo numerato») è nel direction contract di
`.impeccable/surfaces/src-renderer.md` e nello spec
`docs/plans/2026-10-23-desktop-ossatura-design.md`.
