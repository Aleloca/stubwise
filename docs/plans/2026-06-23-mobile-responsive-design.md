# Stubwise web — Mobile responsive (design)

**Data:** 2026-06-23
**Stato:** design da validare.
**Origine:** audit di responsività di `apps/web` (giugno 2026). L'app è desktop-only:
viewport meta già presente, ma quasi nessun CSS responsive (17 utility responsive su 65
file). Causa radice = app-shell con sidebar fissa sempre visibile + layout a tre zone dei
Docs dentro lo shell.

## Obiettivo

Rendere `apps/web` **usabile e gradevole su mobile** (≥ 320px di larghezza), preservando
l'estetica "terminal/monospace" attuale, senza nuove dipendenze e senza regressioni desktop.
"Usabile" = nessuno scroll orizzontale indesiderato, navigazione raggiungibile, contenuto a
piena larghezza, target touch adeguati.

## Principi

1. **Mobile-first additivo.** Gli stili base valgono per mobile; si *aggiunge* `sm:`/`md:`/
   `lg:` per arricchire verso il desktop. I breakpoint default di Tailwind v4 sono intatti
   (`sm 640 / md 768 / lg 1024`; nessun override `@theme` in `styles.css`), quindi il lavoro
   è puramente additivo e non tocca il desktop esistente.
2. **Preservare l'estetica.** Niente redesign: stesso look monospace/terminal, stessi colori,
   stesse classi. Si cambia solo *come si dispone* il contenuto a larghezze ridotte.
3. **Zero nuove dipendenze.** Drawer/off-canvas e top bar custom con Tailwind + stato React
   minimale, coerenti con i componenti esistenti (no librerie UI).
4. **Layout via CSS, stato via JS minimo.** La scelta sidebar-vs-drawer è pura CSS
   (`hidden md:flex` / `md:hidden`); solo l'apertura/chiusura dei drawer è stato React.
5. **Un solo pattern drawer.** Lo stesso primitivo off-canvas serve app-shell, albero Docs e
   chat Docs — non tre implementazioni diverse.

## Breakpoint strategy

| Breakpoint | Largh. | Comportamento app-shell | Comportamento Docs |
|---|---|---|---|
| base (mobile) | < 768 | top bar + hamburger; sidebar come drawer | albero e chat come drawer; pagina a piena larghezza |
| `md` | ≥ 768 | sidebar fissa visibile; niente top bar | (Docs ancora a drawer fino a `lg`) |
| `lg` | ≥ 1024 | come oggi | tre zone affiancate come oggi |

Scelta: l'app-shell collassa sotto **`md`**; il layout Docs (più colonne) collassa sotto
**`lg`**. Nel range `md`–`lg` si ha la sidebar fissa ma i Docs ancora a drawer (corretto: con
sidebar + tre colonne non c'è spazio prima di `lg`).

## Architettura — primitivi condivisi

Tre piccoli pezzi nuovi, riusati ovunque (in `apps/web/src/components/`):

1. **`Drawer`** (off-canvas) — `components/drawer.tsx`. Props: `open`, `onClose`, `side`
   (`"left" | "right"`), `children`, `aria-label`. Rende: un backdrop (`fixed inset-0
   bg-black/50`, click→`onClose`) + un pannello `fixed inset-y-0` (`left-0`/`right-0`) con
   `translate-x` togglato da `open`, `transition-transform`. Chiude su Escape; blocca lo
   scroll del body mentre è aperto; trap del focus base. Larghezza pannello: `w-[min(86vw,
   20rem)]` (mai più largo del viewport).
2. **`MobileTopBar`** — barra superiore visibile solo `md:hidden`, con hamburger (apre il
   drawer di navigazione), il wordmark `stubwise_`, ed eventuale slot azione. Altezza ~`h-12`.
3. **`useMediaQuery(query)`** (opzionale) — hook minimale per i pochi casi che richiedono
   logica JS dipendente dal breakpoint (es. chiudere automaticamente un drawer quando si passa
   a desktop). La maggior parte del lavoro resta CSS; l'hook si usa solo dove serve davvero.

Comportamento comune dei drawer: **si chiudono al cambio rotta** (navigazione) e al click su
una voce, così su mobile l'utente naviga e il drawer sparisce.

---

## Fase 1 — App-shell responsive + quick win (sblocca tutto)

È la fase ad alto impatto: una volta che lo shell cede la larghezza piena su mobile, le pagine
che già impilano sotto `lg` (dettaglio ticket/progetto, settings, login) diventano usabili
quasi gratis.

### 1.1 App-shell (`components/app-layout.tsx`)
Oggi: `<div className="flex h-screen overflow-hidden">` + `<aside className="w-60 shrink-0
…">` sempre reso + `<main className="flex-1">` (`app-layout.tsx:55-96`).

Nuovo:
- La **sidebar** diventa `hidden md:flex` (resta identica da `md` in su).
- Si aggiunge una **`MobileTopBar`** (`md:hidden`) con hamburger + wordmark.
- La stessa nav (`NAV_ITEMS`) viene resa dentro un **`Drawer side="left"`** (`md:hidden`),
  aperto dall'hamburger; le voci chiudono il drawer al click.
- `<main>` resta `flex-1` ma su mobile parte sotto la top bar e occupa il 100% della larghezza.
- Stato `navOpen` locale; chiusura su cambio rotta (router subscribe) e su Escape (dal Drawer).
- Accessibilità: hamburger `aria-expanded`/`aria-controls`, drawer `role="dialog"`
  `aria-modal`, focus all'apertura, ritorno focus alla chiusura.

### 1.2 Quick win di padding e larghezze
- **Padding pagine**: i ~9 `p-8` non condizionati (`tickets/index.tsx:117`, `tickets/$id.tsx:187`,
  `board.tsx:169`, `projects/index.tsx:21`, `projects/$slug.tsx:63`, `team.tsx:39`,
  `settings/layout.tsx:35`, `docs/index.tsx:18`, `page-placeholder.tsx`) →
  `px-4 py-6 sm:p-6 lg:p-8`. (Valutare una classe utility condivisa `.page` per non
  duplicare.)
- **Tabelle markdown**: `styles.css` `.markdown table` → avvolgere/abilitare scroll orizzontale
  (`display:block; overflow-x:auto` sul wrapper, oppure `overflow-x:auto` su `.markdown`),
  così una tabella larga in un body ticket/doc non sfora.
- **Team Slack picker**: input `w-64` e lista `w-72` (`team.tsx:393,416`) → `w-full sm:w-72`.
- **Modale nuovo ticket**: overlay `p-6` (`new-ticket-dialog.tsx:60`) → `p-3 sm:p-6` (il
  pannello è già `w-full max-w-lg` con grid interna `sm:grid-cols-2`, ok).

**Esito Fase 1:** l'app è navigabile e leggibile su mobile; nessuno scroll orizzontale sulle
pagine standard.

---

## Fase 2 — Docs space responsive (tre zone → drawer)

Oggi (`routes/docs/$projectId.tsx:34-60`): `<aside w-72>` (albero + ricerca + pannello
generazione) + `<section flex-1>` (pagina) + `<DocsChat>` che rende `<aside w-96>`
(`components/docs-chat.tsx:196`). Dentro lo shell sono ~912px di chrome fisso.

Nuovo (collasso sotto `lg`):
- L'**albero/sidebar Docs** (`w-72`) diventa `hidden lg:flex`; sotto `lg` è un **`Drawer
  side="left"`** aperto da un pulsante "Indice/Menu" in una **sotto-barra Docs** (una riga
  sticky in cima alla sezione, `lg:hidden`, con: pulsante indice, titolo spazio, pulsante
  chat). Riusa il primitivo `Drawer`.
- La **`<section>` pagina** diventa a piena larghezza sotto `lg`.
- La **chat** (`docs-chat.tsx`): il pannello aperto `w-96 border-l` diventa, sotto `lg`, un
  **drawer a piena altezza** (`Drawer side="right"`, `w-[min(92vw, 28rem)]`) o overlay quasi
  full-screen; il toggle resta ma vive nella sotto-barra Docs su mobile (oltre al FAB attuale).
- Il **pannello di generazione** e la **ricerca** vivono dentro il drawer dell'albero su
  mobile (sono già nell'aside sinistro), quindi seguono l'albero senza lavoro extra.
- Entrambi i drawer Docs si chiudono al cambio pagina (navigazione a una pagina doc) e su
  selezione di un risultato di ricerca.

**Esito Fase 2:** lo spazio Docs è pienamente usabile su mobile — si naviga l'albero da un
drawer, si legge la pagina a piena larghezza, si apre la chat come overlay.

---

## Fase 3 — Polish

- **Board/Kanban** (`board.tsx:169,227`): mantiene le colonne in scroll orizzontale
  (`overflow-x-auto`, già presente) ma: padding responsive, `scroll-snap-x` per agganciare le
  colonne, header più compatto su mobile, e verifica del drag&drop touch (dnd-kit
  `PointerSensor` distanza 8 già configurato). *Decisione aperta:* in alternativa, su mobile una
  vista a **colonna singola con selettore di stato** (più comoda del kanban orizzontale su
  telefono). Raccomando lo scroll orizzontale con snap per la Fase 3, valutando la singola
  colonna come follow-up se l'esperienza non convince.
- **Settings** (`settings/layout.tsx:41`): impila a `lg`; portare a **`md:`** o trasformare la
  sotto-nav in una **tab bar orizzontale scrollabile** su mobile (più ergonomica della lista
  verticale mono).
- **Target touch**: pass sistematico sui bottoni/nav `py-1`/`py-1.5` (es. `app-layout.tsx:91`,
  azioni ticket, revoke/unlink team) → `min-h-9`/`min-h-11` per avvicinarsi ai 44px iOS.
- **Tipografia mono**: le label `text-[10px]`/`text-[11px]` con `tracking-[0.18em]` sono
  piccole/strette su mobile; valutare un leggero aumento o riduzione del tracking sotto `sm`.
  Opzionale, non bloccante.

---

## Cosa è già responsive (no/poco lavoro)
Login/setup (`auth-shell.tsx`), righe ticket (`ticket-row.tsx`), dettaglio ticket 2-col
(`tickets/$id.tsx:230`), dettaglio progetto 2-col (`projects/$slug.tsx:93`), le due `<table>`
reali (già in `overflow-x-auto`), i `<select>` nativi, la grid interna del modale nuovo ticket.
Beneficiano automaticamente della Fase 1 (shell a piena larghezza).

## Testing
- **Component test** (vitest + testing-library): per il `Drawer` (apertura/chiusura, Escape,
  backdrop, chiusura su nav) e per l'app-shell (hamburger visibile `md:hidden`, sidebar
  `hidden md:flex`, voce nel drawer naviga e chiude). Per i Docs: i pulsanti indice/chat
  aprono i drawer; selezione pagina chiude il drawer.
- **Verifica manuale responsive**: DevTools a 320/375/414/768/1024px sulle pagine chiave
  (tickets, board, ticket detail, settings, docs hub, docs space, chat).
- **E2E Playwright** (solo CI, per modifiche UI): un flusso mobile (viewport telefono) che apre
  il drawer di navigazione, naviga, apre lo spazio Docs e il suo albero/chat.
- Nessuna regressione desktop: i test esistenti restano verdi (le modifiche sono additive con
  prefissi responsive).

## Rischi / decisioni
- **Board su mobile** — scroll orizzontale con snap (raccomandato) vs colonna singola: da
  confermare; raccomando lo scroll, follow-up se serve.
- **Drawer custom vs libreria** — custom (no nuove dipendenze), con focus-trap di base; se in
  futuro servisse robustezza a11y, valutare una libreria headless.
- **`md` vs `lg` per lo shell** — shell a `md`, Docs a `lg` (motivato sopra).
- **Scope estetico** — nessun redesign; solo riflusso responsivo.

## Fuori scope
- Redesign visivo / nuova palette / nuovi componenti non strettamente necessari al riflusso.
- PWA / offline / gesture avanzate.
- Ottimizzazioni performance non legate al layout.

## Fasatura (riassunto)
1. **Fase 1** — app-shell responsive (drawer + top bar) + quick win (padding, tabelle md,
   picker, modale). *Sblocca l'usabilità mobile.*
2. **Fase 2** — Docs space: albero e chat a drawer, pagina a piena larghezza.
3. **Fase 3** — polish: board, settings tab, target touch, tipografia.
