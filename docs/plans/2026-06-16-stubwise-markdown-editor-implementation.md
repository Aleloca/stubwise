# Feature 4 — Editor markdown ricco — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans / subagent-driven-development.

**Goal:** Sostituire le textarea "nude" per body ticket e commenti con un editor markdown leggero: textarea + toolbar (bold/italic/link/code/list) + tab anteprima live che riusa il render esistente. Nessuna migrazione, nessun cambio API (il testo resta markdown salvato come prima).

**Architecture:** Nuovo componente controllato `MarkdownEditor` ({ value, onChange, id, placeholder, label }) con toolbar che inserisce sintassi markdown attorno alla selezione del textarea e un toggle Write/Preview (Preview usa il componente `Markdown` esistente). Usato in `new-ticket-dialog` (body) e nel composer commenti di `activity-feed`, **preservando** gli `id` (`ticket-body`, `comment-body`), il submit e il focus esistenti.

**Design:** `docs/plans/2026-06-16-stubwise-team-tracker-design.md`. **Convenzioni:** TDD, i18n en/it (parità), E2E se si toccano i flussi coperti (commenti/new-ticket), review spec+qualità. Solo frontend.

---

### Task 1: Componente `MarkdownEditor`

**Files:** nuovo `apps/web/src/components/markdown-editor.tsx`, test `markdown-editor.test.tsx`, i18n `en.json`/`it.json`.

- Props: `{ id: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; "aria-label"?: string }` (controllato dal chiamante; non gestisce submit).
- **Toolbar**: bottoni Bold (`**…**`), Italic (`*…*`), Code (`` `…` ``), Link (`[…](url)`), Bulleted list (`- ` su righe). Ogni bottone: prende la selezione corrente del textarea (`selectionStart/End`), avvolge/inserisce la sintassi, chiama `onChange` col nuovo valore, e ripristina una selezione sensata (es. seleziona il testo wrappato o posiziona il cursore). Usa una `ref` al textarea. Bottoni con `type="button"` (non submit) e `aria-label` i18n.
- **Tabs Write/Preview**: due tab; Write mostra textarea+toolbar; Preview rende `<Markdown source={value} />` (vuoto → un placeholder "Nothing to preview"). Stato locale `mode`.
- Il textarea mantiene `id={id}` (così i chiamanti/focus/E2E continuano a funzionare) e `placeholder`. Stile coerente col design control-room (riusa le classi delle textarea esistenti).
- i18n: `tickets:editor.*` (o `common:editor.*`) per aria-label toolbar (bold/italic/code/link/list), "Write", "Preview", "Nothing to preview". Parità en/it.

**Test (vitest+happy-dom, Testing Library):**
- Bold su testo selezionato → `onChange` chiamato con `**sel**` (simula selezione via `setSelectionRange` o props controllate);
- inserimento link → `[sel](url)`;
- toggle Preview → rende l'HTML markdown (es. `**x**` mostra `<strong>x</strong>`); Write torna alla textarea;
- i bottoni toolbar sono `type=button` (non inviano form) — verifica che non scatenino submit;
- empty preview → placeholder.

**Commit:** `feat(web): componente MarkdownEditor (toolbar + anteprima)`

---

### Task 2: Integrazione (new-ticket-dialog + composer commenti)

**Files:** `apps/web/src/components/new-ticket-dialog.tsx`, `apps/web/src/components/activity-feed.tsx`, test relativi, E2E.

- **new-ticket-dialog**: sostituisci la `<textarea id="ticket-body">` con `<MarkdownEditor id="ticket-body" value={body} onChange={setBody} placeholder=... aria-label=... />`. Mantieni label, submit, validazione (body trim opzionale) invariati.
- **activity-feed composer**: sostituisci la `<textarea id="comment-body">` con `<MarkdownEditor id="comment-body" value={body} onChange={setBody} ... />`. **PRESERVA**: `id="comment-body"` (per `focusCommentBox` in $id.tsx e per i selettori E2E/label "Add a comment"), il submit del form e il reset dopo l'invio. NOTA: `focusCommentBox` fa `getElementById("comment-body").focus()` — assicurati che l'`id` sia sul textarea reale; se in Preview mode il textarea non è montato, valuta che il focus su Rifiuta forzi mode=Write (o che il composer parta sempre in Write). Mantieni il flusso "Rifiuta piano → focus commento" funzionante.
- Aggiorna i test dei due componenti (il testo si digita ora nel MarkdownEditor; i selettori per label/submit restano). 
- **E2E** (`core-flows.spec.ts`): il flusso commento usa `getByLabel("Add a comment")` + button "Comment"; il flusso new-ticket usa "Description (optional)" + i campi. Assicurati che il MarkdownEditor esponga ancora questi label/associazioni (label `htmlFor` → textarea `id`) così i selettori reggono. Esegui `pnpm --filter @stubwise/web e2e` e adegua se serve; deve restare verde.

**Commit:** `feat(web): MarkdownEditor per body ticket e commenti`

---

### Task 3: Docs + verifica finale

**Files:** `apps/docs/.../getting-started/web-app.md`: nota breve che i campi descrizione e commenti supportano markdown con toolbar e anteprima. Inglese. `pnpm --filter @stubwise/docs build`.

**Verifica finale:** `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter @stubwise/web e2e`, `pnpm -r build`. Code review finale. Deploy: NESSUNA migrazione (solo frontend → rebuild caddy, che contiene la web app; server/worker invariati ma li rebuildo per coerenza o solo caddy). Verifica /health + CI. Nessun cambio env/infra.

**Commit:** `docs: editor markdown`
