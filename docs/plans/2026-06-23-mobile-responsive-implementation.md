# Mobile responsive — Implementation Plan (3 fasi)

> **For Claude:** REQUIRED SUB-SKILL: usa superpowers:executing-plans (o subagent-driven) per
> eseguire questo piano task-by-task.

**Goal:** Rendere `apps/web` mobile-friendly (≥320px) preservando l'estetica terminal, senza
nuove dipendenze, senza regressioni desktop.

**Architecture:** Un primitivo `Drawer` off-canvas condiviso + una `MobileTopBar`; l'app-shell
mostra la sidebar `hidden md:flex` e, sotto `md`, una top bar con hamburger che apre la nav in
un drawer. Lo spazio Docs collassa albero e chat in drawer sotto `lg`. Tutto additivo con
prefissi responsive Tailwind (default v4: `sm 640 / md 768 / lg 1024`).

**Design di riferimento:** `docs/plans/2026-06-23-mobile-responsive-design.md`.

**Convenzioni:** mobile-first additivo; nessuna nuova dipendenza; riuso del `Drawer` ovunque;
commit per task; messaggi `feat(mobile): …` / `test(mobile): …`. Chiudere i commit con
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Verifica continua:** dal root, `pnpm --filter @stubwise/web typecheck`, i test web del file
toccato (`apps/web`: `npx vitest run <file>`), e `pnpm lint` (root). Verifica responsive
manuale in DevTools a 320/375/768/1024px. E2E Playwright solo in CI.

**Pattern di riferimento (leggere prima):** `components/app-layout.tsx`, `router.tsx` (per il
subscribe al cambio rotta), `routes/docs.test.tsx` (pattern test `mockApi`/`renderApp`/
`createMemoryHistory`), `styles.css` (Tailwind v4 + `.markdown`), `components/markdown.tsx`.

---

## Milestone 0 — Primitivi condivisi

### Task 0.1: `useMediaQuery` hook
**Files:** Create `apps/web/src/lib/use-media-query.ts`; Test `apps/web/src/lib/use-media-query.test.ts`.

**Step 1 (test):** renderizza un componente che usa `useMediaQuery("(min-width: 768px)")`;
mocka `window.matchMedia` (jsdom non lo implementa: definirlo in `apps/web/src/test/setup.ts`
se non già presente) e asserisci che il valore segua i cambi di `matches`.

**Step 2 (impl):**
```ts
import { useEffect, useState } from "react";

/** True quando la media query è soddisfatta. Reattivo ai cambi di viewport. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && "matchMedia" in window
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
```
Verifica che `test/setup.ts` definisca un `matchMedia` mock (con `addEventListener`/
`removeEventListener`) per i test; se manca, aggiungerlo.

**Step 3:** `pnpm --filter @stubwise/web test -- use-media-query` → verde. Commit
`feat(mobile): hook useMediaQuery`.

### Task 0.2: Componente `Drawer` (off-canvas)
**Files:** Create `apps/web/src/components/drawer.tsx`; Test `apps/web/src/components/drawer.test.tsx`.

**Step 1 (test):** rendi un `Drawer` con `open`; asserisci: pannello visibile quando `open`,
`onClose` chiamato su click del backdrop e su `Escape`; con `open=false` il pannello è
`aria-hidden`/non interattivo; `role="dialog"` + `aria-modal`.

**Step 2 (impl):**
```tsx
import { useEffect, useRef } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: "left" | "right";
  "aria-label": string;
  children: React.ReactNode;
}

/** Pannello off-canvas riusabile (nav app-shell, albero/chat Docs). */
export function Drawer({ open, onClose, side = "left", children, ...rest }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // blocca lo scroll del body
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const translate = open ? "translate-x-0" : side === "left" ? "-translate-x-full" : "translate-x-full";
  const edge = side === "left" ? "left-0" : "right-0";
  return (
    <div className={open ? "" : "pointer-events-none"} aria-hidden={!open}>
      {/* backdrop */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={`fixed inset-y-0 ${edge} z-50 w-[min(86vw,20rem)] bg-ink-900 border-line transition-transform duration-200 ${translate} ${side === "left" ? "border-r" : "border-l"}`}
        {...rest}
      >
        {children}
      </div>
    </div>
  );
}
```
(Adatta i token colore/bordo a quelli reali del repo — controlla classi tipo `bg-ink-900`/
`border-line` usate in `app-layout.tsx`.) Focus-trap di base = focus al pannello; trap
completo opzionale.

**Step 3:** test verde. Commit `feat(mobile): primitivo Drawer off-canvas`.

### Task 0.3: Helper "chiudi al cambio rotta"
**Files:** Modify `apps/web/src/lib/` (un piccolo hook `useCloseOnRouteChange(close)`), oppure
implementarlo inline dove serve.

**Step 1:** hook che usa il router TanStack (`useRouterState`/`useLocation`) per chiamare
`close()` quando `location.pathname` cambia. Leggi `router.tsx` per l'API esatta esposta.
```ts
import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
export function useCloseOnRouteChange(close: () => void) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => { close(); }, [pathname, close]);
}
```
**Step 2:** commit `feat(mobile): hook useCloseOnRouteChange`.

---

## Fase 1 — App-shell responsive + quick win

### Task 1.1: Sidebar → `hidden md:flex` + MobileTopBar + drawer nav
**Files:** Modify `apps/web/src/components/app-layout.tsx`; Test
`apps/web/src/components/app-layout.test.tsx` (Create se non esiste; altrimenti estendi).

**Step 1 (test, mockApi/renderApp da `routes/docs.test.tsx`):**
- a viewport desktop (default jsdom): la sidebar `nav` è presente; la top bar mobile NO (è
  `md:hidden`). *Nota:* jsdom non applica le media query CSS al rendering; verifica invece la
  PRESENZA degli elementi e delle classi (`hidden md:flex` sull'aside, `md:hidden` sulla top
  bar) e il comportamento JS: cliccare l'hamburger apre il drawer (il drawer nav diventa
  `open`), una voce di nav chiude il drawer, Escape chiude.
- asserisci che le `NAV_ITEMS` sono rese sia nella sidebar sia nel drawer (stessa sorgente).

**Step 2 (impl):**
- Estrai la lista nav in un piccolo componente `NavLinks` riusato da sidebar e drawer (evita
  duplicazione di `NAV_ITEMS`).
- `<aside>` esistente → aggiungi `hidden md:flex` (resta identico da `md`).
- Aggiungi una `MobileTopBar` (`md:hidden`, `h-12`, sticky top) con: bottone hamburger
  (`aria-expanded={navOpen}` `aria-controls="mobile-nav"`), wordmark `stubwise_`.
- Stato `const [navOpen, setNavOpen] = useState(false)`.
- `<Drawer open={navOpen} onClose={() => setNavOpen(false)} side="left" aria-label="Navigazione">`
  contenente `<NavLinks onNavigate={() => setNavOpen(false)} />`.
- `useCloseOnRouteChange(() => setNavOpen(false))`.
- Layout: il contenitore resta `flex h-screen overflow-hidden`; su mobile `<main>` parte sotto
  la top bar (`flex-1 overflow-…`); verifica che non resti `min-w`/larghezze che forzino scroll
  orizzontale.

**Step 3:** test verde; typecheck; lint. Commit `feat(mobile): app-shell con drawer di
navigazione e top bar`.

### Task 1.2: Padding pagine responsive
**Files:** Modify `tickets/index.tsx:117`, `tickets/$id.tsx:187`, `board.tsx:169`,
`projects/index.tsx:21`, `projects/$slug.tsx:63`, `team.tsx:39`, `settings/layout.tsx:35`,
`docs/index.tsx:18`, `components/page-placeholder.tsx`.

**Step 1:** sostituisci ogni `p-8` (contenitore di pagina) con `px-4 py-6 sm:p-6 lg:p-8`.
*Opzionale (consigliato):* definisci una classe utility condivisa `.page` in `styles.css`
(`@apply px-4 py-6 sm:p-6 lg:p-8`) e usala, per non duplicare. Documenta la scelta.

**Step 2:** verifica visiva 320/768px; i test esistenti delle pagine restano verdi (le classi
sono additive). Commit `feat(mobile): padding pagine responsive`.

### Task 1.3: Tabelle markdown scrollabili
**Files:** Modify `apps/web/src/styles.css` (regola `.markdown table` ~riga 131) e/o
`components/markdown.tsx`.

**Step 1:** abilita lo scroll orizzontale per le tabelle larghe nei body markdown:
opzione A — `styles.css`: `.markdown table { display:block; overflow-x:auto; max-width:100%; }`;
opzione B — avvolgi la tabella renderizzata in un `<div class="overflow-x-auto">` (richiede un
renderer custom in `markdown.tsx`). Preferisci A (solo CSS, nessun cambio al renderer).

**Step 2:** verifica con una tabella larga in un body ticket/doc → scrolla, non sfora.
Commit `feat(mobile): tabelle markdown scrollabili su mobile`.

### Task 1.4: Quick win larghezze (Slack picker + modale)
**Files:** Modify `apps/web/src/routes/team.tsx:393,416`; `components/new-ticket-dialog.tsx:60`.

**Step 1:** team Slack picker: input `w-64` → `w-full sm:w-64`; lista `w-72` → `w-full
sm:w-72` (assicura che il contenitore consenta full-width su mobile). Modale: overlay `p-6` →
`p-3 sm:p-6`.

**Step 2:** verifica a 320/375px (nessuno sforamento); test esistenti verdi. Commit
`feat(mobile): larghezze picker Slack e padding modale responsive`.

**Esito Fase 1:** dal menu hamburger si naviga ovunque; le pagine standard (incl. quelle già
`lg:`-stacking) sono usabili e senza scroll orizzontale su mobile.

---

## Fase 2 — Docs space responsive

### Task 2.1: Sotto-barra Docs + albero a drawer
**Files:** Modify `apps/web/src/routes/docs/$projectId.tsx` (il `DocsSpaceLayout`, ~righe
34-60); Test `apps/web/src/routes/docs-space.test.tsx` (estendi).

**Step 1 (test):** in `DocsSpaceLayout`: a viewport mobile (verifica via JS/classi) esiste una
sotto-barra Docs (`lg:hidden`) con un bottone "Indice" che apre un drawer contenente la
`DocsTree`; cliccare una pagina nell'albero chiude il drawer (riusa `useCloseOnRouteChange` o
`onNavigate`). L'aside albero ha `hidden lg:flex`.

**Step 2 (impl):**
- L'`<aside className="w-72 …">` (albero + ricerca + pannello generazione) → aggiungi
  `hidden lg:flex`.
- Aggiungi una sotto-barra `lg:hidden` sticky in cima alla sezione con: bottone "Indice"
  (apre drawer albero), titolo spazio, bottone "Chat" (Task 2.2).
- `<Drawer side="left" open={treeOpen} onClose={…} aria-label="Indice documentazione">` con lo
  stesso contenuto dell'aside (estrai un `DocsSidebar` riusato da aside e drawer per non
  duplicare albero/ricerca/pannello).
- La `<section>` pagina: piena larghezza sotto `lg`.
- `useCloseOnRouteChange` per chiudere il drawer alla navigazione a una pagina doc e su
  selezione di un risultato di ricerca.

**Step 3:** test verde; typecheck; lint. Commit `feat(mobile): Docs — albero in drawer e
sotto-barra`.

### Task 2.2: Chat Docs come drawer su mobile
**Files:** Modify `apps/web/src/components/docs-chat.tsx` (~riga 196); Test
`components/docs-chat.test.tsx` (estendi).

**Step 1 (test):** il pannello chat aperto, sotto `lg`, è reso come overlay/drawer a piena
altezza (non una colonna `w-96` affiancata); il toggle nella sotto-barra Docs lo apre; il FAB
attuale resta su mobile; chiusura su backdrop/Escape.

**Step 2 (impl):**
- Il pannello aperto `w-96 border-l` → su `lg` resta colonna affiancata (`hidden lg:flex` per
  la variante colonna); sotto `lg`, rendilo dentro un `<Drawer side="right" aria-label="Chat
  documentazione">` con `w-[min(92vw,28rem)]` a piena altezza.
- Il toggle vive sia nel FAB attuale sia nella sotto-barra Docs (Task 2.1).
- Mantieni invariata tutta la logica SSE/streaming/citazioni: cambia solo il *contenitore*.

**Step 3:** test verde. Commit `feat(mobile): Docs — chat come drawer su mobile`.

**Esito Fase 2:** spazio Docs pienamente usabile su mobile (albero da drawer, pagina piena,
chat overlay).

---

## Fase 3 — Polish

### Task 3.1: Board/Kanban mobile (scroll orizzontale + snap)
**Files:** Modify `apps/web/src/routes/board.tsx:169,227`.

**Step 1:** padding `p-8` (già coperto da Task 1.2 se incluso; altrimenti qui) responsive;
aggiungi `scroll-snap-type: x mandatory` al contenitore colonne e `scroll-snap-align: start`
alle colonne (via classi Tailwind `snap-x snap-mandatory` / `snap-start`); header più compatto
su mobile (`text-…`, spacing). Verifica il DnD touch (dnd-kit `PointerSensor` distanza 8 già
attivo) a 375px.

**Step 2:** verifica manuale del drag su touch emulato; test esistenti board verdi. Commit
`feat(mobile): board con scroll-snap e padding responsive`.

### Task 3.2: Settings — tab bar orizzontale su mobile
**Files:** Modify `apps/web/src/routes/settings/layout.tsx:41`.

**Step 1:** la sotto-nav `lg:grid-cols-[12rem_…]` → sotto `lg` rendila come **tab bar
orizzontale scrollabile** (`flex gap-2 overflow-x-auto` con le voci, `lg:` torna a colonna
laterale). Mantieni l'indicatore di voce attiva.

**Step 2:** verifica 375/1024px; test settings verdi. Commit `feat(mobile): settings con tab
bar su mobile`.

### Task 3.3: Target touch
**Files:** Modify i bottoni/nav `py-1`/`py-1.5` (es. `app-layout.tsx:91` logout, azioni in
`tickets/$id.tsx`, revoke/unlink in `team.tsx`, voci nav `app-layout.tsx:68`).

**Step 1:** pass sistematico: aggiungi `min-h-9` (≈36px) ai controlli secondari e `min-h-11`
(≈44px) ai primari/voci nav, senza cambiare l'aspetto desktop (solo altezza minima). Documenta
la convenzione (es. una classe `.tap-target`).

**Step 2:** verifica che nulla si rompa nel layout desktop; lint. Commit `feat(mobile): target
touch adeguati`.

### Task 3.4: Tipografia mono (opzionale)
**Files:** Modify le label `text-[10px]`/`text-[11px]` con `tracking-[0.18em]` dove risultano
poco leggibili su mobile.

**Step 1:** valuta un leggero aumento (`sm:` torna ai valori attuali) o riduzione del tracking
sotto `sm`. Cambiamento conservativo, opzionale; saltare se non migliora chiaramente.

**Step 2:** commit `feat(mobile): leggibilità label mono su mobile` (se fatto).

---

## Verifica finale
- `pnpm build && pnpm typecheck && pnpm lint` (root) → verdi.
- `pnpm --filter @stubwise/web test` → verde (nuovi test Drawer/shell/Docs + nessuna
  regressione).
- **Verifica responsive manuale** a 320/375/414/768/1024px sulle pagine: tickets, board,
  ticket detail, settings, projects, docs hub, docs space, chat. Checklist: nessuno scroll
  orizzontale; nav raggiungibile; drawer aprono/chiudono e si chiudono al cambio rotta; chat
  Docs overlay; board scrolla con snap.
- **E2E Playwright** (solo CI): un flusso a viewport telefono (apri drawer nav → naviga → apri
  spazio Docs → apri albero e chat).
- Nessuna regressione desktop (tutto additivo).

## Note di deploy
Solo `apps/web` cambia → deploy = rebuild dell'immagine web (`docker compose up -d --build`),
nessuna migrazione, nessun impatto su server/worker/db.

## Ordine di esecuzione consigliato
M0 (primitivi) → Fase 1 (sblocca l'usabilità) → Fase 2 (Docs) → Fase 3 (polish). Ogni fase è
indipendentemente deployabile e migliora l'esperienza mobile in modo incrementale.
