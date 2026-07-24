# Auto-update Docs — affidabilità della sezione "Aree nuove non documentate"

Data: 2026-07-24

## Contesto

L'auto-update Docs su push (`apps/worker/src/docs/auto-update.ts`,
`packages/docs-engine`) appende alle pagine di release una sezione **"Aree nuove
non documentate … Valuta una rigenerazione completa per coprirle."** In prod
questa sezione ripete sempre gli stessi path tra release diverse (es.
`.stubwise.json`, `audin-api`, `audin-api/src`, `audin-webapp/src`,
`packages/database`), rendendola più fastidiosa che utile: mischia rumore e
segnale, si ripete, e a volte suggerisce una cura (rigenerazione completa) che
non coprirebbe comunque quei path.

L'analisi del codice ha isolato **due cause distinte**:

1. **`isNoise` troppo stretto** (`auto-update.ts:166`). Filtra solo lockfile e le
   cartelle `plans/ docs/ manual/ guides/ .github/`. I file di config/manifest a
   qualsiasi livello (`.stubwise.json`, `package.json`, `tsconfig*.json`,
   `Dockerfile`, …) non sono filtrati → diventano "aree materiali" che nessun
   agente documenterà mai → ristampate a ogni push che le tocca. Per questi path
   anche il consiglio di rigenerazione completa è fuorviante: `orient.ts`
   classifica i config come process-noise e non li documenta.

2. **Disallineamento copertura/svuotamento del residual** in `growNewAreaPages`
   (`auto-update.ts:686`). Lo svuotamento del residual (riga 848) usa un match
   **simmetrico** (`sourcePath` antenato *o* discendente dell'area), mentre la
   copertura futura (`pathCovers`, ancestor-only, `recursive/dag.ts:32`) richiede
   che il `sourcePath` sia **antenato-o-uguale**. Se il mini-orient documenta un
   sottoinsieme più stretto dell'area aggregata (es. `audin-api/src/orders` per
   l'area `audin-api/src`), l'area esce dal residual *adesso* ma i fratelli futuri
   (`audin-api/src/users/…`) non sono coperti → l'area riappare. Ciclo.

## Obiettivo

Rendere la sezione "Aree nuove non documentate" **affidabile**: quando appare,
deve essere un segnale vero e azionabile (un buco reale nella copertura di codice
documentabile), non rumore ripetuto.

Non-obiettivi (YAGNI):
- memoria persistente del "già valutato e scartato" dal mini-orient;
- riscrittura del testo del consiglio (il Fix 1 lo rende già corretto);
- modifiche alla rigenerazione completa (`orient.ts`).

## Fix 1 — Escludere i config dalle "aree", non dalle release note

`isNoise` serve oggi a **due** scopi: (a) decidere se un push è *materiale* (→
genera la nota di rilascio e avanza `commitSha`), (b) filtrare i file che
diventano aree. Vogliamo che un push di soli config **produca ancora la nota di
rilascio** (tracciabilità di bump/config) ma **non generi mai un'area**.

Quindi **non** si tocca `isNoise`. Si introduce un predicato dedicato:

- Nuovo `isConfigLike(path)` in `packages/docs-engine/src/affected-pages.ts`, con
  una **regola generica** per basename/estensione:
  - basename noti: `.stubwise.json`, `package.json`, `tsconfig*.json`,
    `Dockerfile*`, `.dockerignore`, `.gitignore`, `.npmrc`, `.nvmrc`,
    `pnpm-workspace.yaml`, `.editorconfig`, `.prettierrc*`, `.eslintrc*`,
    `eslint.config.*`;
  - pattern: `*.config.{js,ts,mjs,cjs,json}`.
  - La lista è pensata per essere estesa facilmente.
- Applicato in **un solo punto**: dentro `mapAffectedPages`, quando un file non è
  coperto da alcuna pagina, viene scartato dal set `newAreas` se `isConfigLike`.
  I config restano nei `material` che alimentano la release note e la Fase 2.

Effetto: i config non diventano mai "aree nuove"; sparisce con essi il consiglio
fuorviante di rigenerazione completa per quei path.

## Fix 2 — Allineare copertura e svuotamento del residual (ibrido)

Due modifiche in `growNewAreaPages` (`auto-update.ts:686`):

1. **`sourcePath` = path dell'area quando la copertura è 1:1.** Prima del loop di
   inserimento si calcola, per ogni area aggregata, quante proposte la intersecano
   (via `sourcePaths[0]`). Per una proposta la cui area è coperta da **quella sola**
   proposta, si persiste come `sourcePath` **il path dell'area aggregata** invece
   di `sourcePaths[0]` (potenzialmente più stretto). Se più proposte suddividono la
   stessa area (struttura fine voluta), si lasciano i path specifici di ciascuna.

2. **Svuotamento del residual ancestor-only.** Alla riga 848 si rimuove il ramo
   simmetrico `sp.startsWith(area.path + "/")`: un'area esce dal residual solo se
   un `sourcePath` è **antenato-o-uguale** (`area.path === sp ||
   area.path.startsWith(sp + "/")`) — la stessa regola di `pathCovers`. Così
   "coperto adesso" ⇔ "coperto ai push futuri".

Effetto combinato: nel caso comune (una pagina per area) il `sourcePath` coincide
con l'area → area coperta davvero → non si ripresenta. In caso di suddivisione
fine, le sotto-parti non ancora documentate restano nel residual **onestamente**,
senza falsi "coperto".

**Dedup `sourcePath`:** allargando all'area, due pagine (cicli/generazioni
diversi) potrebbero condividere lo stesso `sourcePath`. `mapAffectedPages` sceglie
"la più specifica"; a parità serve un tie-break deterministico (es. la più recente
per `position`). Da verificare se già esiste; in caso, aggiungerlo.

## Testing

Il grosso della logica è in `packages/docs-engine` (funzioni pure) + un piccolo
aggancio in `auto-update.ts`.

Test unitari:
- `isConfigLike` — tabella di casi veri (`.stubwise.json`,
  `audin-api/package.json`, `tsconfig.build.json`, `vite.config.ts`) e falsi
  (`audin-api/src/orders/service.ts`, `README.md`, `packages/database/schema.ts`);
  verifica che i lockfile (già in `isNoise`) non regrediscano.
- `mapAffectedPages` — file config non coperto NON entra in `newAreas`; file di
  codice non coperto SÌ; push misto (config + codice nella stessa dir) → solo
  l'area di codice.
- Fix 2 — proprietà anti-ciclo: se un'area esce dal residual, ogni file sotto
  quell'area è coperto da `pathCovers`. Caso proposta stretta su area larga →
  l'area **resta**; caso 1:1 → l'area **esce** e `sourcePath` = path dell'area.

Regressione:
- gate "tutto rumore → nessuna release note" invariato: un push di soli config
  deve **ancora** produrre la nota (i config restano `material`).

End-to-end (runner mockato in `auto-update.ts`):
- "area larga documentata da una pagina" → al ciclo successivo (nuovo file
  fratello) l'area **non** ricompare in `newAreasSection`.

## File toccati

- `packages/docs-engine/src/affected-pages.ts` — `isConfigLike`, filtro in
  `mapAffectedPages`.
- `apps/worker/src/docs/auto-update.ts` — `growNewAreaPages`: scelta `sourcePath`
  1:1 e svuotamento residual ancestor-only.
- Eventuale tie-break `sourcePath` in `mapAffectedPages` (se non già presente).
- Test in `packages/docs-engine` (+ eventuale caso e2e in worker).

## Deploy

Solo **worker** (nessuna migrazione, nessuna env, nessun cambio schema). Deploy
sicuro solo con `select id from doc_generations where status in
('running','paused')` vuoto; l'auto-update è best-effort. La sezione migliorata
appare dalle release successive al deploy; le pagine di release già esistenti non
vengono riscritte retroattivamente.
