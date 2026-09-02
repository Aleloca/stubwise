---
title: Stubwise come centro nevralgico dei progetti — programma
date: 2026-08-31
status: validato (brainstorming), da dettagliare per fase
stubwise:
  project: stubwise
  backlogItem: 5b0fe521-de32-437d-be81-9286a03d3468 # https://stubwise.thecove.it/backlog/5b0fe521-de32-437d-be81-9286a03d3468
---

# Stubwise come centro nevralgico dei progetti

Documento **programma**: fissa visione, principi, decisioni prese e l'ordine
delle fasi. Ogni fase avrà il proprio design + piano in `docs/plans/`
(convenzione del repo) e la propria voce di backlog/ticket. Qui non c'è dettaglio
implementativo: ci sono le decisioni che i design di fase NON devono rimettere
in discussione senza un motivo nuovo.

## 1. Perché

Entro fine ottobre 2026 il team di sviluppo non ci sarà più. Sui progetti
subentrano persone **senza background tecnico ma con buona visione di
prodotto**, che lavoreranno sui repo attraverso Claude; il titolare resta l'unico
maintainer tecnico e l'unico che decide cosa si rilascia.

Stubwise deve quindi diventare il **punto unico "sempre attivo"** di tutte le
operazioni sui progetti: documentazione, stato, timeline, esecuzione dei lavori,
validazione, rilascio, comunicazioni. E deve **raggiungere le persone** (non
aspettare che aprano la web app) per tenere i progetti in movimento.

## 2. Cosa esiste già (base del programma)

Il motore sempre attivo esiste: il **worker sul VPS** esegue col claude CLI
intake e deep dive del backlog, `run-ai` dal piano salvato, self-repair sui test,
apertura PR, review AI delle PR, notifiche (webhook Slack/Discord/generico),
report di attività, monitoraggio server, knowledge graph (graphify). Il flusso
`voce di backlog → ticket → job → PR → review` è interamente server-side.

Ciò che oggi è **locale** è solo l'*authoring* (design e piani scritti con Claude
Code + MCP `@stubwise/mcp`) e l'*esecuzione locale* via `/stubwise:start`. Non
esiste: un tool MCP che lanci `run-ai`; una inbox in-app; push mobile; un modo
per l'agente di fare domande a metà lavoro; skill/plugin lato worker (l'agente
vede solo le skill project-scoped nel worktree del repo target).

## 3. Principi (decisi)

1. **Il motore è il worker sul VPS.** Nessuna operazione dipende dal PC di
   qualcuno. Claude Code locale, web, Slack e app mobile sono *porte d'ingresso*
   sullo stesso stato, non motori.
2. **Gli umani intervengono ai checkpoint**: domanda dell'agente, approvazione
   del piano, PR, rilascio. Tutti raggiungibili da notifica + un tap.
3. **Mai decisioni prese dall'AI in autonomia nel dubbio.** Se l'agente ha una
   domanda, si ferma e aspetta (default: resta in attesa, nessun timeout che
   "procede con la raccomandata").
4. **Tutto passa da una PR** con validazione (review AI + test) e decisione umana
   di rilascio. I non-tecnici non mergiano né rilasciano (ruoli).
5. **Non replicare Claude Code in una web app.** Si portano su Stubwise i
   *workflow* (idea → design → piano → esecuzione → PR → approvazione), non il
   terminale. Chi sa usare Claude Code continua a farlo per l'authoring e manda
   l'esecuzione sul VPS.
6. **Determinismo su ciò che esegue codice**: plugin/skill pinnati a commit,
   inventario visibile, aggiornamenti espliciti, verifica con smoke run.

## 4. Decisioni prese nel brainstorming

| Tema | Decisione |
| --- | --- |
| Priorità | Prima il "cervello" (proattività, pianificazione interattiva, skill), poi l'app, poi roadmap/Gmail, poi workflow guidato web e staging. |
| Canale del ping (v1) | **Slack con bottoni + inbox in-app** (deep link). Push native con l'app. Email più avanti (oggi nessun SMTP). |
| App mobile | **Sì, presto, nativa**: React Native *bare* + TypeScript in `apps/mobile`. **Niente Expo.** |
| "Procedi" del ping | Avvia deep dive + piano sul worker, poi si ferma in `awaiting_plan_approval`; chi ha il ruolo approva e parte l'esecuzione. |
| Domande dell'agente | Tool `ask_user` (MCP locale al run) → stato `awaiting_input` → notifica con bottoni → ripresa con `--resume`. Tetto ai round. Timeout default: **resta in attesa**. |
| Authoring locale | Nuovo tool MCP `run_ticket` (→ `POST /tickets/:id/run-ai`) + comando `/stubwise:run` ("esegui in Stubwise"). `/stubwise:start` resta per l'esecuzione locale. |
| Skill/plugin lato worker | **Registro d'istanza + abilitazione per progetto**, gestito da UI (admin). Meccanica: materializzazione pinnata a commit + `--plugin-dir` per run. Plugin base Stubwise bundlato e sempre attivo. |
| Gmail | Read-only, segnali → **proposte** da confermare; mai mutazioni silenziose. Verificare scope restricted / app internal Workspace. |
| Staging | Ricetta per progetto generata da agente e confermata da umano + preview env per PR deterministico. Solo progetti "compose-abili" in v1. Ultima fase. |

## 5. Le fasi

### Fase 0 — Fondamenta

Piccola, sblocca tutto il resto.

- **`run_ticket`** nel package `@stubwise/mcp` (chiama `run-ai`; con piano
  salvato il worker esegue in `resume_mode=execute`) e comando
  **`/stubwise:run`**: stessi passi 1–2 di `start` (assicura ticket, `set_design`,
  `set_plan`), poi `run_ticket` invece di implementare in locale. Aggiornare la
  skill `stubwise` (repo e `~/.claude/skills`).
- **Inbox in-app**: modello "notifica azionabile" (destinatario, progetto,
  titolo, corpo, azioni tipizzate, stato aperta/gestita/snoozed, scadenza) +
  pagina/pannello nella SPA. È la sorgente dati di Slack interattivo e delle push
  dell'app: le notifiche esistenti (webhook) diventano un *canale* di questa
  inbox, non un sistema parallelo.
- **Slack interattivo**: bottoni (Block Kit) sulle notifiche con azioni, callback
  firmato (la verifica HMAC esiste già per slash command e modal).
- **Ruoli**: `operator` (propone, chatta, risponde alle domande dell'agente) e
  `maintainer` (approva piani, mergia, rilascia, gestisce plugin e ricette).
  Oggi c'è solo admin/utente: va definito il mapping.

### Fase 1 — Pianificazione interattiva (`ask_user`)

- Il worker serve al run un MCP locale con `ask_user({ question, options[2..4]
  {label, consequence}, recommended, allowFreeText })`. Il tool registra la
  domanda, risponde "in attesa: chiudi il turno".
- Nuovo stato job **`awaiting_input`** (fratello di `awaiting_plan_approval`):
  nessun processo bloccato, nessun problema di staleness né di riavvio worker.
  Il worktree della sessione deve sopravvivere fra i turni (verificare cosa fa
  oggi la sessione di analisi della chat backlog dopo un riavvio del worker).
- La domanda diventa notifica azionabile (inbox/Slack/app) con i bottoni +
  "Altro" a testo libero. La risposta riprende la sessione con `--resume`.
- Tetto ai round (default 5). Timeout per progetto: default *resta in attesa*
  (il pulse lo ricorda); opzione "dopo N ore procedi con la raccomandata,
  segnandola come assunzione" disponibile ma **off**.
- Regola di ingaggio nel prompt: scelte reversibili/minori le fa l'agente e le
  elenca in "Decisioni e assunzioni" del piano; chiede solo quando le letture
  porterebbero a lavori materialmente diversi.
- Vale per deep dive, chat di refinement e fix in esecuzione. Chi scrive il piano
  in locale con Claude Code non ha round (ha già risposto nel brainstorming).

### Fase 2 — Pulse proattivo

- Job periodico per progetto abilitato (toggle `pulseEnabled`, default off):
  progetto "fermo" = nessun job AI attivo, nessuna PR in attesa, nessuna domanda
  aperta, backlog con voci pronte.
- Ranking urgenza/effort dalle stime esistenti; notifica azionabile con 2–3
  proposte: "Procedi con X" (convert → ticket → deep dive + piano →
  `awaiting_plan_approval`), "Questa va raffinata" (link alla chat), "Snooze".
- Guardrail: quiet hours, max un ping per progetto ogni N giorni, snooze,
  nessun ping se c'è già una domanda/approvazione pendente (prima si chiude
  quella).
- Extra a costo basso: tool MCP `list_proposals` così Claude Code locale mostra
  a inizio sessione le proposte pendenti (pull, non push).

### Fase 3 — Registro plugin/skill

- **Registro d'istanza** (admin): sorgente = repo GitHub + ref **pinnato a
  commit** (o `plugin@marketplace`, risolto a commit); materializzato in un
  volume `claude-plugins/<nome>/<sha>`; passato con `--plugin-dir` alle run.
  Aggiornamento = azione esplicita con diff dell'inventario.
- **Abilitazione per progetto**, con toggle sulle **singole skill** del plugin.
  Inventario (skill, comandi, hook, MCP) mostrato prima dell'abilitazione.
- **Plugin base Stubwise** bundlato nell'immagine del worker, sempre attivo:
  skill di pianificazione (delega a `writing-plans` quando presente), uso di
  `ask_user`, convenzioni PR, contratto della run ("worktree/branch/PR li
  gestisce il worker; il piano si salva col tool X").
- Adattamenti noti per superpowers: spegnere lato server
  `using-git-worktrees` e `finishing-a-development-branch`; `writing-plans` deve
  salvare il piano sul ticket (oltre che in `docs/plans/` nella PR);
  `brainstorming` deve usare `ask_user`.
- **Verifica**: smoke run all'abilitazione su un repo fixture (skill caricate,
  `ask_user` chiamato al bivio, piano salvato, nessun worktree/branch creato
  dall'agente) + suite di scenari golden nel repo da rilanciare quando si
  aggiorna un plugin o un prompt del worker.
- Sicurezza: hook e script girano nel container del worker con accesso a repo e
  credenziali → solo admin, pin, inventario, hook elencati uno per uno.

### Fase 4 — App mobile

- `apps/mobile`, React Native bare + TypeScript, nel monorepo; riusa gli schemi
  Zod di `packages/shared` e la logica del client API della SPA
  (`apps/web/src/lib/api.ts`, da estrarre in un package condiviso se serve).
- Auth con PAT/login esistente; push native APNs/FCM come terzo canale della
  inbox (fase 0).
- v1: inbox e azioni (rispondi alle domande, approva piano, procedi), stato dei
  progetti (cosa sta girando, cosa aspetta chi), dettaglio ticket/job con
  timeline, PR in attesa, cattura rapida (nota → backlog).
- Il design dell'esperienza viene fatto **prima**, con Claude Design, dal brief
  in `docs/plans/2026-08-31-mobile-app-claude-design-brief.md`.
- **Rinvii decisi al design della v1 (2 set 2026)**, collocati nelle fasi a
  valle: "Rilascia (merge)" dalla card PR → fase 8; riassunto "in breve" di
  piano e PR per non tecnici → fase 5; chat di raffinamento guidata a bottoni
  → fase 7; azioni dinamiche nella notifica espansa (Content Extension),
  widget WidgetKit/Glance, dettatura, login via QR, quiet hours per utente →
  **fase 4b**; canale email → backlog (nessun SMTP).

### Fase 5 — Roadmap e narrativa

- Timeline per progetto (milestone + ticket + PR + report di attività) con
  narrativa AI "dove siamo, cosa è cambiato, cosa blocca".
- Brief settimanale di stato per progetto, leggibile da non-tecnici e
  inoltrabile.
- Registro decisioni (ADR leggero) nei Docs, alimentato da chat, `ask_user`,
  PR ed email.
- Riassunti "in breve" in linguaggio umano di piani e PR (per le card
  dell'app e dell'inbox): rinvio dalla fase 4.

### Fase 4b — App mobile v2 (nativo avanzato)

Dopo la fase 5, con l'app già in mano agli utenti: Notification Content
Extension per le opzioni della domanda direttamente nella notifica espansa;
widget WidgetKit (iOS) e Glance (Android) con "decisioni in attesa"; dettatura
dedicata nella cattura rapida; login via QR dalla web app; quiet hours per
utente (preferenza server + rispetto nel canale push).

### Fase 6 — Gmail / Calendar

- OAuth per utente (account Google collegato dalle impostazioni), scope
  read-only. Verificare: `gmail.readonly` è scope *restricted*; se il dominio è
  Google Workspace, app *internal* evita la verifica CASA.
- Routing email → progetto (domini mittente, etichette, parole chiave,
  conferma utente); estrazione di segnali (decisione, richiesta, scadenza,
  blocco) → **proposte** nella inbox (aggiorna stato, crea voce di backlog,
  crea milestone) confermate con un tap. Mai mutazioni silenziose.
- Calendar: scadenze e meeting → milestone/promemoria.

### Fase 7 — Workflow guidato web per non-tecnici

- Conversazione di lavoro per progetto che guida lungo idea → proposta → piano
  in linguaggio semplice → esecuzione → PR, con bottoni (`ask_user`) più che
  prompt liberi. È la versione web di ciò che chi sa usare Claude Code fa con
  `/stubwise:run`.
- Sessioni con scrittura su worktree per i maintainer.
- Chat di raffinamento del backlog guidata a bottoni (domande dell'agente
  con opzioni, testo libero come fallback): consumata anche dall'app (rinvio
  dalla fase 4).

### Fase 8 — Staging per PR e coda di rilascio

- Ricetta di staging per progetto: generata una volta da un agente
  (compose/porte/env/seed), confermata dal maintainer. `.env` cifrati esistenti.
- Preview env per PR sul VPS (`pr-<n>.<progetto>.staging.<dominio>` via Caddy),
  TTL, limiti risorse. Solo progetti compose-abili.
- Coda di rilascio unica per il maintainer: PR in attesa con verdetto review,
  esito test, link staging, rischio, riassunto non-tecnico, merge/deploy.
- Livelli di autonomia per progetto (es. basso rischio + validazione e staging
  verdi → auto-merge) per non affogare il maintainer.
- "Rilascia (merge)" dalla card PR dell'inbox e dell'app (rinvio dalla fase 4).

## 6. Ordine e stima onesta

Ordine: 0 → 1 → 2 → 3 → 4 → 5 → 4b → 6 → 7 → 8. Le fasi 1 e 3 rendono i risultati
*affidabili* e per questo precedono l'app. Nei due mesi ci stanno
realisticamente 0–3 e una prima app essenziale (4); 5–6 subito dopo; 7–8 nel
trimestre successivo. Il design dell'app (Claude Design) parte subito, in
parallelo alla fase 0.

## 7. Domande aperte (da chiudere nei design di fase)

- Fase 0: mapping esatto dei ruoli sugli utenti esistenti; l'inbox sostituisce
  o affianca la pagina Notifiche delle impostazioni.
- Fase 1: persistenza del worktree di sessione fra riavvii del worker.
- Fase 4: distribuzione dell'app (TestFlight/Play internal) e gestione delle
  build senza Expo/EAS.
- Fase 6: il dominio è Google Workspace? (decide il percorso di verifica).
- Fase 8: quali progetti attuali sono compose-abili.
