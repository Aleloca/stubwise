# App desktop, parte 1: l'ossatura — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creare `apps/desktop`, un prototipo Electron con dati finti che
contiene l'ossatura completa dell'app: binario, colonna, temi, tipografia,
i18n, livello dati finto, ⌘K, notifiche, convenzioni Mac/Windows, con ogni
destinazione navigabile in stato «da progettare».

**Architecture:** `electron-vite` con tre ingressi (main, preload,
renderer). Il renderer è una SPA React 19 + TanStack Router (hash history,
perché Electron carica da `file://`) + TanStack Query sopra un livello dati
finto asincrono; gira anche in un browser normale (nessuna API Electron è
obbligatoria), così test, screenshot e revisione non dipendono dalla
finestra nativa. Stile con Tailwind v4 sopra token CSS (chiaro/scuro).

**Tech Stack:** Electron (ultima stabile all'installazione), electron-vite,
React 19, TypeScript 5.6+, Vite 7, TanStack Router + Query, Tailwind v4,
i18next + react-i18next, Vitest + happy-dom + Testing Library, Playwright
(solo per gli screenshot di revisione), font Archivo variabile via
`@fontsource-variable/archivo` (servito localmente: l'app non dipende dalla
rete per i caratteri).

**Spec:** `docs/plans/2026-10-23-desktop-ossatura-design.md` (contesto:
`apps/desktop/PRODUCT.md`, `apps/desktop/docs/web-inventory.md`).

## Global Constraints

- Package `@stubwise/desktop`, privato, in `apps/desktop`; Node >= 22, pnpm 10.9.
- Nessun DB, nessuna chiamata di rete: tutti i dati vengono da `src/renderer/data/`.
- Lingue: **inglese di default**, italiano seconda; ogni testo visibile passa da i18n (nessuna stringa letterale nei componenti, salvo dati finti).
- Temi chiaro e scuro, entrambi completi; default = segue il sistema; override salvato nelle preferenze.
- Monospace vietato, tranne il monogramma «S_» del logo (ambra `#f5a623` su `#0f1318`).
- Il codice è sempre affiancato dal nome; il colore non è mai l'unico segnale.
- Movimento 150–250 ms, solo per cambi di stato; `prefers-reduced-motion` azzera le transizioni.
- Testo funzionale ≥ 11 px; padding interno ≥ 8 px nei contenitori con bordo o fondo.
- La CI fallisce su lint: `pnpm lint`, `pnpm typecheck` e `pnpm --filter @stubwise/desktop test` verdi a ogni commit.
- Moduli di progetto: sempre presenti Overview, Tasks, Planning, Requests, Drive, Chat, Settings; moduli accendibili Docs, Releases, Support, Servers.

## Review Focus

1. **Nomi lunghi e italiano** (es. «Brennero Logistics — Supplier Portal», etichette italiane più lunghe): nessun testo esce dal suo contenitore, si tronca con ellissi e il nome intero resta leggibile al passaggio del mouse. → test in Task 6.
2. **Più di 9 progetti fissati**: il binario scorre nella sola zona delle tessere, campanella/⌘K/profilo restano fissi in fondo; ⌘1…⌘9 coprono le prime nove. → test in Task 6.
3. **Link diretto a un modulo spento** (`#/p/MKT/releases` su un progetto senza Releases): reindirizza alla Overview del progetto, non pagina rotta. Codice progetto inesistente → pagina «progetto non trovato» con ritorno alla Home. → test in Task 5.
4. **Cambio di tema del sistema ad app aperta** mentre la preferenza è «sistema»: l'app segue senza ricaricare; con override esplicito non segue. → test in Task 2.
5. **Finestra stretta**: dimensione minima 1024×680 in Electron; sotto 1200 px di larghezza il pannello di dettaglio si sovrappone invece di stringere l'area di lavoro. → test in Task 7.

---

### Task 1: Scaffold di `apps/desktop` e direction contract

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.node.json`, `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`
- Create: `apps/desktop/src/renderer/index.html`, `apps/desktop/src/renderer/main.tsx`, `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/test/setup.ts`
- Create: `apps/desktop/src/renderer/App.test.tsx`
- Create: `apps/desktop/README.md` (come avviarlo, cosa è finto)
- Modify: `package.json` (radice) — `pnpm.onlyBuiltDependencies` aggiunge `"electron"`
- Modify: `apps/desktop/.gitignore` — aggiunge `out/`, `.impeccable/review/`

**Interfaces:**
- Produces: script `dev` (electron-vite dev), `build`, `test` (vitest run), `typecheck` (tsc --noEmit sui due tsconfig), `preview:web` (vite sul solo renderer, per screenshot in browser). Componente `App` esportato da `src/renderer/App.tsx`.

- [ ] **Step 1: Registrare il direction contract.** Scrivi il corpo del surface brief (sei blocchi THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM, FINISH, ~150 parole) dalla sezione «Il linguaggio visivo» dello spec; FORM cita `seed:1d874331d6e60edc` e la scelta del maintainer (challenger «Catalogo numerato», `brand-identity-canon-saville-catalog-sleeve`); FINISH verbatim come in `new-work.md` §5. Poi, da `apps/desktop`:
  `"<impeccable>/scripts/impeccable" surface-brief write src/renderer <body-file>` e rileggilo con `surface-brief read src/renderer` verificando i sei blocchi e il seed. (`<impeccable>` = `/Users/aleloca/.claude-stubwise-thecove-it/plugins/cache/impeccable/impeccable/4.7.0/skills/impeccable`.)
- [ ] **Step 2: Test che fallisce** — `App.test.tsx`: `it("monta l'app e mostra il nome del prodotto")` → `render(<App />)`; `expect(screen.getByText("Stubwise")).toBeInTheDocument()`.
- [ ] **Step 3:** `pnpm --filter @stubwise/desktop test` → FAIL (modulo mancante).
- [ ] **Step 4: Scaffold.** `pnpm add` di electron, electron-vite, react@19, react-dom@19, @types/react@19, @types/react-dom@19, vite, @vitejs/plugin-react, vitest, happy-dom, @testing-library/react, @testing-library/jest-dom, @testing-library/user-event, typescript (versioni allineate a `apps/web` dove esistono). `tsconfig.json` estende `../../tsconfig.base.json` con `module: ESNext`, `moduleResolution: Bundler`, `jsx: react-jsx`, `lib` DOM, `resolveJsonModule`, `noEmit`. Main: `BrowserWindow` 1440×900, `minWidth: 1024`, `minHeight: 680`, `backgroundColor` del tema risolto, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Preload espone via `contextBridge` solo `window.stubwise = { platform: process.platform }`. `vitest.config.ts`: happy-dom, setup in `src/renderer/test/setup.ts` (stesso schema di `apps/web/src/test/setup.ts`: jest-dom, cleanup, matchMedia pilotabile con `setMatchMedia`).
- [ ] **Step 5:** test → PASS; `pnpm --filter @stubwise/desktop typecheck` e `pnpm lint` → verdi.
- [ ] **Step 6: Verifica manuale.** `pnpm --filter @stubwise/desktop dev` apre la finestra con «Stubwise»; chiudila.
- [ ] **Step 7: Commit** — `feat(desktop): scaffold dell'app Electron e direction contract`.

### Task 2: Token, temi e tipografia

**Files:**
- Create: `src/renderer/styles/tokens.css`, `src/renderer/styles/index.css`
- Create: `src/renderer/theme/theme.ts`, `src/renderer/theme/ThemeProvider.tsx`, `src/renderer/theme/theme.test.ts`, `src/renderer/theme/ThemeProvider.test.tsx`
(percorsi relativi a `apps/desktop/`, qui e in seguito)

**Interfaces:**
- Produces:
  - `type ThemePreference = "system" | "light" | "dark"`; `type ResolvedTheme = "light" | "dark"`
  - `resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme`
  - `ThemeProvider` (mette `data-theme` su `<html>`) e `useTheme(): { preference, resolved, setPreference(p: ThemePreference): void }`; preferenza persistita in `localStorage["stubwise.theme"]` con try/catch.
  - Variabili CSS (in `tokens.css`, sotto `:root[data-theme="light"]` e `:root[data-theme="dark"]`): `--ground`, `--surface`, `--rail`, `--ink`, `--ink-muted`, `--ink-faint`, `--rule`, `--rule-strong`, `--focus`, `--critical`, `--warning`, `--positive`, `--claude`, `--dept-1` … `--dept-8` (palette reparti, distinguibili in entrambi i temi, contrasto ≥ 3:1 sul fondo come segnale non testuale), scala tipografica `--text-xs` (12) `--text-sm` (13) `--text-md` (14) `--text-lg` (16) `--text-xl` (20) `--text-2xl` (28) px, spaziatura su base 4 px, `--duration-fast: 150ms`, `--duration: 200ms`, `--duration-slow: 250ms`, `--ease`.
  - Tailwind v4 `@theme` mappa queste variabili in utility (`bg-ground`, `text-ink-muted`, `border-rule`…).
  - Font: Archivo variabile, `font-variant-numeric: tabular-nums` per codici e date tramite utility `.num`; le etichette di gruppo usano Archivo con `font-stretch` espanso, maiuscolo e spaziatura `0.08em`.

- [ ] **Step 1: Test che falliscono** — `theme.test.ts`: `resolveTheme("system", true) === "dark"`, `resolveTheme("system", false) === "light"`, `resolveTheme("light", true) === "light"`, `resolveTheme("dark", false) === "dark"`. `ThemeProvider.test.tsx`: con preferenza `system` e `setMatchMedia("(prefers-color-scheme: dark)", true)` → `document.documentElement.dataset.theme === "dark"`; poi `setMatchMedia(..., false)` → diventa `"light"` senza rimontare; con `setPreference("dark")` un successivo cambio di sistema NON cambia `data-theme`; preferenza sopravvive a un rimontaggio (localStorage); `localStorage` che lancia → nessun crash, si usa `system`.
- [ ] **Step 2:** test → FAIL.
- [ ] **Step 3:** implementa `theme.ts`, `ThemeProvider.tsx`, `tokens.css`, `index.css` (Tailwind import + `@theme`, reset, `@media (prefers-reduced-motion: reduce)` che porta le durate a `0ms`). Colori definiti in OKLCH, scuro = «copertina» (nero opaco non puro, inchiostro bianco caldo-neutro), chiaro = negativo (carta neutra, non crema; inchiostro quasi nero).
- [ ] **Step 4:** test → PASS; typecheck, lint verdi.
- [ ] **Step 5: Commit** — `feat(desktop): token, temi chiaro/scuro e tipografia`.

### Task 3: i18n

**Files:**
- Create: `src/renderer/i18n/index.ts`, `src/renderer/i18n/locales/en.json`, `src/renderer/i18n/locales/it.json`, `src/renderer/i18n/parity.test.ts`, `src/renderer/i18n/language.test.ts`

**Interfaces:**
- Produces: `i18n` inizializzato (side-effect import) con `fallbackLng: "en"`, `lng` da `localStorage["stubwise.language"]` o `"en"`; `setLanguage(lang: "en" | "it"): void`; namespace unico `translation` con chiavi radice `nav`, `rail`, `project`, `modules`, `palette`, `notifications`, `placeholder`, `prefs`, `common`. Il setup dei test importa `../i18n`.

- [ ] **Step 1: Test che falliscono** — `parity.test.ts` (stesso schema di `apps/web/src/i18n/parity.test.ts`): l'insieme delle chiavi appiattite di `en.json` e `it.json` è identico. `language.test.ts`: default `en`; `setLanguage("it")` → `i18n.language === "it"` e persistito; `t("nav.home")` restituisce `"Home"` in en.
- [ ] **Step 2:** FAIL. **Step 3:** implementa (le chiavi crescono nei task successivi: ogni task aggiunge le sue in entrambi i file). **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): i18n inglese/italiano con test di parità`.

### Task 4: Livello dati finto

**Files:**
- Create: `src/renderer/data/types.ts`, `src/renderer/data/seed/{departments,people,projects,tasks,notifications}.ts`, `src/renderer/data/api.ts`, `src/renderer/data/viewer.ts`, `src/renderer/data/queries.ts`
- Create: `src/renderer/data/seed.test.ts`, `src/renderer/data/api.test.ts`, `src/renderer/data/viewer.test.ts`
- Modify: `package.json` — dipendenze `@stubwise/shared: workspace:*`, `@tanstack/react-query`

**Interfaces:**
- Produces (`types.ts`):
  - `Department { id: string; name: string; colorToken: \`--dept-${1|2|3|4|5|6|7|8}\` }`
  - `Person { id: string; name: string; initials: string; departmentIds: string[]; isClaude: boolean; presetRole: string }` (Claude: `isClaude: true`, `departmentIds: []`)
  - `ProjectModule = "docs" | "releases" | "support" | "servers"`; `ProjectTemplate = "software" | "marketing" | "client" | "empty"`
  - `Project { id: string; code: string /* 2–4 maiuscole, univoco */; name: string; kind: "internal" | "client"; clientName?: string; template: ProjectTemplate; modules: ProjectModule[]; memberIds: string[]; signals: { waitingOnViewer: boolean; claudeWorking: boolean } }`
  - `TaskStatus` = valori di `ticketStatusSchema` di `@stubwise/shared`; `Task { id; code /* \`${project.code}-${n}\` */; projectId; title; departmentId; assigneeId: string | null; status: TaskStatus; dueDate: string | null /* ISO */; plannedWeek: string | null /* ISO week "2026-W43" */ }`
  - `AppNotification { id; kind: string /* valori di notificationKindSchema */; projectId: string | null; title: string; body: string; createdAt: string; read: boolean; archived: boolean; snoozedUntil: string | null; link: string /* route hash */ }`
  - `Viewer { personId: string; instancePermissions: InstancePermission[]; projectPermissions: Record<string, ProjectPermission[]> }` coi tipi di `@stubwise/shared/permissions`.
- Produces (`api.ts`, ogni funzione `async`, latenza simulata 150–400 ms, disattivabile in test con `setLatency(0)`; errore iniettabile con `failNext(fnName)` per provare gli stati d'errore):
  `listDepartments()`, `listPeople()`, `listProjects()`, `getProjectByCode(code: string): Promise<Project | null>`, `listPinnedProjectIds(): Promise<string[]>`, `setPinned(projectId: string, pinned: boolean)`, `listTasks(filter?: { projectId?: string; assigneeId?: string })`, `listNotifications()`, `markNotification(id: string, change: { read?: boolean; archived?: boolean; snoozedUntil?: string | null })`, `search(q: string): Promise<SearchResult[]>` con `SearchResult = { kind: "project" | "task" | "person"; id: string; code?: string; label: string; route: string }`.
- Produces (`viewer.ts`): `VIEW_AS_PERSONAS` (almeno: Giulia Ferri marketing «Project Lead» su alcuni progetti; uno sviluppatore «Developer»; un collaboratore dell'assistenza «Contributor»; un full admin), `useViewer(): { viewer: Viewer; setPersona(personId: string): void }`, `can(viewer, perm, projectId?)` con la semantica di oggi (full admin vede tutto; permesso di progetto senza `projectId` = «in almeno un progetto»); `canSeeAdmin(viewer: Viewer): boolean` (vero se ha almeno uno fra `instance.full_admin`, `users.manage`, `users.invite`, `roles.manage`, `settings.manage`, `ai_providers.manage`, `git_accounts.manage`, `plugins.manage`, `integrations.manage`, `monitor.manage`, `usage.view`). Permessi derivati dai `PRESET_ROLES` di `@stubwise/shared`.
- Produces (`queries.ts`): hook TanStack Query `useProjects()`, `useProject(code)`, `usePinnedProjects()`, `useNotifications()`, `useSearch(q)` e mutation corrispondenti.

- [ ] **Step 1: Test che falliscono** — `seed.test.ts`: 50 progetti; codici progetto univoci e `/^[A-Z]{2,4}$/`; almeno 2 `internal` (fra cui `STW` Stubwise e `AUD` Audin) e almeno 30 `client`; ogni progetto ha i moduli coerenti col template (`software` ⊇ `docs`, `releases`; `marketing` senza `releases`/`servers`); 5 reparti; ~25 persone più Claude, almeno una persona con 2 reparti; ogni task ha progetto, reparto e (se assegnata) persona esistenti; codici task univoci nel formato `CODE-n`; almeno una task per ogni `TaskStatus`; almeno un nome progetto ≥ 34 caratteri (per il Review Focus 1); almeno 12 progetti fissati per Giulia (Review Focus 2); almeno una notifica per 5 `kind` diversi. `api.test.ts`: con `setLatency(0)`, `getProjectByCode("XXXX")` → `null`; `setPinned` cambia `listPinnedProjectIds`; `failNext("listProjects")` fa rifiutare la chiamata successiva e solo quella; `search("cbv")` trova il progetto e le sue task (maiuscole indifferenti). `viewer.test.ts`: il Developer non ha `plans.approve` né `release.merge`; il full admin ha tutto ovunque; Giulia ha `project.settings.manage` solo sui progetti dove è Project Lead.
- [ ] **Step 2:** FAIL. **Step 3:** implementa; i dati sono inventati e realistici (clienti italiani verosimili e inesistenti, nessun dato reale), titoli task in inglese di tutti i reparti. **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): livello dati finto con seed, permessi e «vedi come»`.

### Task 5: Router, layout e pagine «da progettare»

**Files:**
- Create: `src/renderer/router.tsx`, `src/renderer/layout/AppLayout.tsx`, `src/renderer/pages/Placeholder.tsx`, `src/renderer/pages/ProjectNotFound.tsx`, `src/renderer/router.test.tsx`
- Modify: `src/renderer/App.tsx` (QueryClientProvider, ThemeProvider, RouterProvider), `App.test.tsx`

**Interfaces:**
- Consumes: `useProject(code)`, `Project.modules` (Task 4).
- Produces: route su hash history —
  `/` → redirect `/home`; `/home`, `/chat`, `/mail`, `/calendar`, `/claude`, `/automations`, `/projects` (Tutti i progetti), `/preferences`, `/admin` (senza `canSeeAdmin(viewer)` → redirect a `/home`);
  `/p/$code` → redirect `/p/$code/overview`; `/p/$code/$section` con `section ∈ {overview, tasks, planning, requests, docs, drive, chat, releases, support, servers, settings}`.
  `PROJECT_SECTIONS: readonly { id: ProjectSection; module?: ProjectModule }[]` in quest'ordine (è l'ordine della colonna). `AppLayout` = griglia binario | colonna | area di lavoro (`<Outlet/>`). `Placeholder({ titleKey })` mostra titolo e il testo `placeholder.body` («This area hasn't been designed yet» / «Quest'area non è ancora stata progettata»), in stato neutro.

- [ ] **Step 1: Test che falliscono** — `router.test.tsx` (router con memory history nei test): `/` porta a `/home` e mostra il titolo «Home»; `/p/AUD` porta a `/p/AUD/overview`; `/p/MKX/releases` su un progetto finto `marketing` (senza `releases`) reindirizza a `/p/MKX/overview`; `/p/ZZZZ/tasks` mostra «Project not found» con un link alla Home; `/p/AUD/bogus` reindirizza a `/p/AUD/overview`; `/admin` con la persona Developer reindirizza a `/home`, col full admin mostra il placeholder «Administration».
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): router, layout a tre zone e pagine da progettare`.

### Task 6: Il binario

**Files:**
- Create: `src/renderer/layout/Rail.tsx`, `src/renderer/layout/ProjectTile.tsx`, `src/renderer/layout/ProfileMenu.tsx`, `src/renderer/layout/useShortcuts.ts`, `src/renderer/layout/Rail.test.tsx`

**Interfaces:**
- Consumes: `usePinnedProjects`, `useViewer`, `can`, `useTheme`, `setLanguage`.
- Produces: `useShortcuts()` registra ⌘/Ctrl+1…9 (tessera N), ⌘/Ctrl+K (apre palette, evento `stubwise:palette`), ⌘/Ctrl+Shift+H (Home).

- [ ] **Step 1: Test che falliscono** — `Rail.test.tsx`: mostra logo, voci Home/Chat/Mail/Calendar/Claude/Automations con etichette accessibili (`aria-label` tradotte) e `aria-current="page"` su quella attiva; una tessera per progetto fissato con codice visibile e nome nel tooltip/`aria-label`; tessera con `waitingOnViewer` ha un indicatore con testo accessibile «Waiting on you»; tessera con `claudeWorking` ha l'indicatore «Claude is working»; con 12 progetti fissati la zona tessere ha `overflow-y: auto` e campanella/⌘K/profilo restano fuori da quella zona; ⌘2 (Ctrl+2 se `platform` non è `darwin`) naviga alla seconda tessera, ⌘0/⌘10 non fanno nulla; il menu profilo mostra «Administration» solo se `canSeeAdmin`; dal menu profilo: tema (sistema/chiaro/scuro), lingua, «View as» con le persone di `VIEW_AS_PERSONAS`; un nome progetto lungo nel tooltip non viene troncato.
- [ ] **Step 2:** FAIL. **Step 3:** implementa (binario largo 64 px, tessere 40×40 col codice in cifre/lettere tabellari, indicatore «aspetta te» = punto pieno, «Claude al lavoro» = anello che pulsa, fermo con movimento ridotto). **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): binario con progetti fissati, scorciatoie e menu profilo`.

### Task 7: La colonna e il cambio di contesto

**Files:**
- Create: `src/renderer/layout/Column.tsx`, `src/renderer/layout/ProjectColumn.tsx`, `src/renderer/layout/PersonalColumn.tsx`, `src/renderer/layout/useDetailPanel.ts`, `src/renderer/layout/Column.test.tsx`

**Interfaces:**
- Consumes: `PROJECT_SECTIONS`, `useProject`, `can`.
- Produces: `Column` sceglie fra `PersonalColumn` (destinazione corrente: titolo e sottoviste — per ora solo il titolo e le sottoviste note: Home «Assigned to me / Delegated / Following»; Chat «Channels / Direct messages»; le altre solo il titolo) e `ProjectColumn` (testata con codice + nome + tipo interno/cliente, voci di `PROJECT_SECTIONS` filtrate per `modules`, «Settings» sempre visibile ma in sola lettura senza `project.settings.manage`). Cambio di contesto animato: la colonna esce/entra con traslazione orizzontale di 12 px + dissolvenza in `--duration`, via View Transitions API quando disponibile, CSS altrimenti, nessuna animazione con movimento ridotto. `useDetailPanel()` gestisce l'apertura di un pannello di dettaglio: affiancato ≥ 1200 px di larghezza, sovrapposto sotto.

- [ ] **Step 1: Test che falliscono** — `Column.test.tsx`: su `/p/AUD/tasks` la colonna mostra «AUD» e «Audin 2.0» e le voci nell'ordine di `PROJECT_SECTIONS`, con «Tasks» corrente; su un progetto `marketing` non compaiono Releases e Servers; il progetto col nome più lungo del seed ha il nome in testata troncato con ellissi (`text-overflow: ellipsis`) e intero nell'attributo `title`; in italiano (`setLanguage("it")`) le voci della colonna restano su una riga; su `/home` mostra la colonna personale; con `setMatchMedia("(min-width: 1200px)", false)` il pannello di dettaglio è in modalità `overlay`, con `true` è `docked`; con `setMatchMedia("(prefers-reduced-motion: reduce)", true)` il cambio di contesto non applica la classe di transizione.
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): colonna personale e di progetto con transizione di contesto`.

### Task 8: ⌘K — cerca, salta, agisci

**Files:**
- Create: `src/renderer/palette/CommandPalette.tsx`, `src/renderer/palette/commands.ts`, `src/renderer/palette/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `useSearch`, `useTheme`, `useViewer`, evento `stubwise:palette`.
- Produces: `Command { id: string; labelKey: string; run(ctx: { navigate; setTheme; setPersona }): void; when?(viewer: Viewer): boolean }`; `COMMANDS` iniziali: «New task» (apre il placeholder delle task del progetto corrente o di Home), «Go to Home», «Go to all projects», «Switch theme: light/dark/system», «View as…». Risultati in gruppi «Projects», «Tasks», «People», «Actions».

- [ ] **Step 1: Test che falliscono** — `CommandPalette.test.tsx`: ⌘K apre la palette col focus nel campo; digitando «cbv» compaiono il progetto CBV (codice + nome) e le sue task; ↓/↑ spostano la selezione, Invio naviga alla route del risultato e chiude; Esc chiude e riporta il focus dove era; digitando «theme» compare l'azione e Invio cambia `data-theme`; una ricerca senza risultati mostra «No results for “…”» con il suggerimento di provare un codice o un nome; il ruolo ARIA è `dialog` con `combobox` + `listbox`.
- [ ] **Step 2:** FAIL. **Step 3:** implementa (palette centrata in alto, larga 640 px, risultati con codice in cifre tabellari e nome). **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): palette ⌘K con ricerca, salti e azioni`.

### Task 9: Pannello notifiche

**Files:**
- Create: `src/renderer/notifications/NotificationsPanel.tsx`, `src/renderer/notifications/NotificationItem.tsx`, `src/renderer/notifications/NotificationsPanel.test.tsx`

**Interfaces:**
- Consumes: `useNotifications`, `markNotification`, campanella del binario (Task 6).
- Produces: pannello laterale che si apre dalla campanella, schede «New / Snoozed / Archived», azioni per elemento «Mark as read», «Archive», «Snooze» (1 h / Tomorrow / 3 days), clic = naviga a `link` e segna letto. Nessuna decisione qui: solo informazioni (le decisioni vivono nella Home, area 2).

- [ ] **Step 1: Test che falliscono** — `NotificationsPanel.test.tsx`: la campanella mostra un punto quando esistono non lette e il suo `aria-label` dice quante; aprire il pannello elenca le non archiviate per data; «Archive» la sposta nella scheda Archived; «Snooze → Tomorrow» la sposta in Snoozed con la data; clic su una notifica naviga al suo `link` e la segna letta; Esc chiude il pannello; stato vuoto «You're all caught up»; con `failNext("listNotifications")` compare l'errore con «Try again», che ricarica.
- [ ] **Step 2:** FAIL. **Step 3:** implementa (pannello da destra, 400 px, sopra l'area di lavoro, entra in `--duration`). **Step 4:** PASS, typecheck, lint.
- [ ] **Step 5: Commit** — `feat(desktop): pannello notifiche`.

### Task 10: Convenzioni Mac/Windows

**Files:**
- Create: `src/renderer/platform/platform.ts`, `src/renderer/platform/platform.test.ts`, `src/main/menu.ts`
- Modify: `src/main/index.ts`, `src/renderer/layout/Rail.tsx`

**Interfaces:**
- Produces: `getPlatform(): "mac" | "windows" | "linux" | "web"` (da `window.stubwise?.platform`, `"web"` se assente); `modKeyLabel(): "⌘" | "Ctrl"`; `shortcutLabel(keys: string[]): string` (es. `["mod","K"]` → «⌘K» su Mac, «Ctrl+K» altrove). Main: su macOS `titleBarStyle: "hiddenInset"` con i semafori posizionati sopra il binario (`trafficLightPosition` allineato al logo); su Windows `titleBarStyle: "hidden"` + `titleBarOverlay` coi colori del tema (aggiornati al cambio tema via IPC `theme:changed`); il binario lascia lo spazio corrispondente e la sua parte alta è area di trascinamento (`-webkit-app-region: drag`, i controlli `no-drag`). Menu applicazione standard per piattaforma (App/File/Edit/View/Window/Help su Mac; File/Edit/View/Help su Windows) con «Search…» ⌘/Ctrl+K e «Preferences…» ⌘, / Ctrl+,.

- [ ] **Step 1: Test che falliscono** — `platform.test.ts`: con `window.stubwise = { platform: "darwin" }` → `modKeyLabel() === "⌘"` e `shortcutLabel(["mod","K"]) === "⌘K"`; con `"win32"` → `"Ctrl"` e `"Ctrl+K"`; senza `window.stubwise` → `getPlatform() === "web"` e si comporta come Windows/Linux. Tutte le etichette di scorciatoia nei componenti passano da `shortcutLabel` (aggiorna il test del binario: su `win32` il tooltip di ⌘K dice «Ctrl+K»).
- [ ] **Step 2:** FAIL. **Step 3:** implementa. **Step 4:** PASS, typecheck, lint. **Step 5: Verifica manuale** su Mac: semafori allineati al logo, finestra trascinabile dalla cima del binario, menu presente.
- [ ] **Step 6: Commit** — `feat(desktop): convenzioni di finestra, menu e scorciatoie per Mac e Windows`.

### Task 11: Revisione visiva e chiusura di Impeccable

**Files:**
- Create: `apps/desktop/scripts/capture.mjs` (Playwright: avvia `preview:web`, cattura in `.impeccable/review/` `desktop-light.png` e `desktop-dark.png` a 1440×900, `narrow.png` a 1024×680, e gli stati: palette aperta, notifiche aperte, progetto `marketing`, menu profilo)
- Create: `apps/desktop/DESIGN.md`, `apps/desktop/.impeccable/design.json` (dal documentatore)

- [ ] **Step 1:** `"<impeccable>/scripts/impeccable" detect --json` sui file del renderer: correggi ciò che è meccanico; il resto va al revisore.
- [ ] **Step 2:** `node apps/desktop/scripts/capture.mjs` e apri ogni immagine: verifica che mostri ciò che dice il nome (niente zone vuote, niente animazioni a metà).
- [ ] **Step 3:** lancia il revisore `impeccable-finish-reviewer` (contesto vergine) con: richiesta originale, spec, direction contract (surface brief di `src/renderer`), percorsi degli screenshot, bozza scelta `.impeccable/mocks/decision/challenger-catalog.html` come riferimento critico, `reference/craft-floor.md`, risultati del detect. Applica la disposizione (fix → un giro di correzioni e ricattura → verdetto; massimo due giri, poi decide il maintainer).
- [ ] **Step 4:** lancia `impeccable-documenter` → `DESIGN.md` + `.impeccable/design.json` in `apps/desktop`.
- [ ] **Step 5:** `pnpm lint`, `pnpm typecheck`, `pnpm --filter @stubwise/desktop test` verdi.
- [ ] **Step 6: Commit** — `docs(desktop): DESIGN.md dell'ossatura e revisione visiva`.
