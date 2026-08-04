# Landing deep redesign — Piano di implementazione

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Design di riferimento:
> `docs/plans/2026-08-04-landing-deep-redesign-design.md` (contiene TUTTA la
> copy e la composizione dei mock: il piano non la ripete).

**Goal:** portare la landing di `apps/docs` al livello di dettaglio deciso nel
design: 4 sezioni deep per pilastro con mock UI ricostruiti e callout, sezione
trust ✗/✓, FAQ, reveal on scroll.

**Architecture:** `Landing.astro` resta l'orchestratore e centralizza le
primitive condivise in `<style is:global>` annidato sotto `.sw-landing`; ogni
sezione nuova è un componente autonomo in
`apps/docs/src/components/landing/` con scoped style solo per il proprio mock.

**Tech stack:** Astro 6 / Starlight 0.40, CSS nesting nativo, nessuna
dipendenza nuova. Verifica: `pnpm --filter @stubwise/docs build` + screenshot
dal dev server (dark, light, mobile ~390px).

**Nota di processo:** un commit per task; alla fine push unico. Il dev server
si avvia con `pnpm --filter @stubwise/docs dev --port 4321` (pagina su
`http://localhost:4321/guide/`).

---

### Task 1: refactor degli stili condivisi in global

**Files:** Modify: `apps/docs/src/components/Landing.astro`

1. Converti il blocco `<style>` scoped in `<style is:global>` annidando TUTTI i
   selettori sotto `.sw-landing { … }` (keyframes a top level; i wrapper
   `:global([data-theme="light"])` diventano `[data-theme="light"] .sw-landing`).
2. Aggiungi le primitive nuove usate dai child: `.lead` (paragrafo di sezione,
   max-width 46rem, colore dim), `.callouts`/`.callout`/`.callout-k` (chip
   annotazione: absolute su desktop, static impilati sotto 60rem), `.kv`/
   `.kv-row`/`.kv-k`/`.kv-v` (righe etichetta/descrizione con border-top),
   `.mockwrap` (position relative + margini), `.chip` (badge inline mono),
   `.rise` (stato pre-reveal; con `prefers-reduced-motion` sempre visibile).
3. `pnpm --filter @stubwise/docs build` → verde.
4. Dev server + screenshot: la pagina deve essere IDENTICA a prima (il refactor
   non cambia il rendering).
5. Commit `refactor(docs): stili landing condivisi in global per i child component`.

### Task 2: sezione DOCUMENT

**Files:** Create: `apps/docs/src/components/landing/DeepDocs.astro` ·
Modify: `Landing.astro` (import + render dopo la sezione platform)

1. Implementa il componente secondo il design (mock sidebar+pagina+chat, 3
   callout, 3 kv, 2 link). Link con `import.meta.env.BASE_URL`.
2. Build verde + screenshot dark/light: callout leggibili, niente overflow
   orizzontale; sotto 60rem i callout si impilano.
3. Commit `feat(docs): sezione deep Document nella landing`.

### Task 3: sezione PLAN

**Files:** Create: `landing/DeepPlan.astro` · Modify: `Landing.astro`

1. Mock card backlog + chat CODE + terminale MCP, 3 callout, 3 kv, 2 link.
2. Build + screenshot come Task 2.
3. Commit `feat(docs): sezione deep Plan nella landing`.

### Task 4: sezione FIX

**Files:** Create: `landing/DeepFix.astro` · Modify: `Landing.astro`

1. Timeline AI activity (7 righe, colori di stato), 3 callout, 3 kv, 2 link.
2. Build + screenshot.
3. Commit `feat(docs): sezione deep Fix nella landing`.

### Task 5: sezione WATCH

**Files:** Create: `landing/DeepWatch.astro` · Modify: `Landing.astro`

1. Doppia card activity/monitor (barre con tacca di soglia in CSS puro), 3
   callout, 3 kv, 2 link.
2. Build + screenshot.
3. Commit `feat(docs): sezione deep Watch nella landing`.

### Task 6: sezione WHY SELF-HOSTED

**Files:** Create: `landing/Trust.astro` · Modify: `Landing.astro`

1. 3 coppie ✗/✓ + trust strip 4 colonne + link security. Colonne → 1 sotto i
   60rem.
2. Build + screenshot.
3. Commit `feat(docs): sezione trust why-self-hosted nella landing`.

### Task 7: FAQ

**Files:** Create: `landing/Faq.astro` · Modify: `Landing.astro`

1. 6 `<details>` stilizzate (marker custom `+`/`×`, border, hover ambra).
   Nessun JS.
2. Build + screenshot (aperto/chiuso).
3. Commit `feat(docs): FAQ nella landing`.

### Task 8: rinumerazione, ancore e rimozione "in depth"

**Files:** Modify: `Landing.astro`

1. Rimuovi la sezione "in depth [02/05]" (assorbita da Document/Plan).
2. Rinumera gli eyebrow a [0x/09] secondo la tabella del design; aggiungi
   `id` alle deep section e trasforma gli indici dei pilastri in anchor-link
   (`#document`, `#plan`, `#fix`, `#watch`).
3. Build; verifica che le ancore scrollino alla sezione giusta.
4. Commit `feat(docs): rinumerazione e ancore dei pilastri`.

### Task 9: reveal on scroll

**Files:** Modify: `Landing.astro`

1. Script unico: `IntersectionObserver` che aggiunge `.in` agli elementi
   `.rise` (threshold ~0.15, unobserve dopo il reveal). Skip totale se
   `matchMedia("(prefers-reduced-motion: reduce)")`.
2. Verifica a schermo (scroll) + con reduce-motion emulato.
3. Commit `feat(docs): reveal on scroll della landing`.

### Task 10: verifica finale e push

1. `pnpm --filter @stubwise/docs build` e `typecheck` → verdi.
2. Screenshot completi: dark desktop, light desktop, mobile ~390px (hero, ogni
   deep section, trust, FAQ, outro). Correggere eventuali overflow.
3. Aggiornare il ticket Stubwise (in_review) e push su main.
