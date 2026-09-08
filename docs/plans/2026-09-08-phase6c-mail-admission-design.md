---
title: Fase 6c — Ammissione della posta separata dall'attribuzione
date: 2026-09-08
status: validato (brainstorming)
program: 2026-08-31-stubwise-nerve-center-program-design.md
extends: 2026-09-07-phase6-google-mail-calendar-design.md
stubwise:
  project: stubwise
  backlog: 868cdecc-a4ed-4d87-9b4e-94a7dd9a1faa
---

# Fase 6c — Ammissione separata dall'attribuzione

Seconda correzione della fase 6, dal primo uso reale. Le regole di
`project_email_routes` rispondono oggi a **due domande diverse con lo stesso
meccanismo**: «questa email è lavoro?» e «di quale progetto parla?». Per i
domini dei propri Workspace la prima risposta è sempre sì, quindi il
maintainer ha dovuto scrivere gli stessi quattro domini su dodici progetti:
quarantotto regole per esprimere quattro fatti.

Questa fase separa **ammissione** (a livello di istanza) da **attribuzione**
(a livello di progetto), e gestisce il caso nuovo che ne nasce: un'email
ammessa che nessuno riesce ad attribuire.

## 1. Stato di partenza (fatti verificati)

- **`inScope` è definito come effetto collaterale dell'attribuzione**:
  `matchRoutes` (`packages/notifications/src/email-routing.ts:299`) pone
  `inScope = entries.length > 0`, cioè «almeno una regola di almeno un
  progetto combacia». Le quattro regole sono **sempre** possedute da un
  progetto (`project_email_routes.project_id NOT NULL`), da cui la
  duplicazione.
- Il pre-filtro è l'unico punto che decide se scaricare il corpo:
  `apps/worker/src/google/poller.ts:645-646` (`if (!preFilter.inScope)
  continue`). Fin qui il messaggio non viene nemmeno letto.
- **I domini dei Workspace sono già a portata di mano**:
  `google_workspaces.domains` (`packages/db/src/schema.ts:3040`) è già letto
  dal join di `loadGoogleAccountCredentials`
  (`packages/google/src/credentials.ts:99`) per il refresh token: aggiungerlo
  alla select costa **zero query**.
- **Header per la posta automatica**: `DEFAULT_METADATA_HEADERS`
  (`packages/google/src/gmail.ts:29`) chiede oggi From, To, Cc, Subject,
  Date, Message-Id. `getMessageMetadata` accetta già un parametro `headers`
  (`:226`): aggiungere `List-Unsubscribe`, `Precedence`, `Auto-Submitted`,
  `List-Id` è **un cambio di array, non una chiamata in più**. Le label
  Gmail (`CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`,
  `SPAM`) sono **già lette e persistite** (`email_messages.labels`), quindi
  una deny-list si tara sui dati veri già raccolti.
- **Nessun freno di spesa sulla posta**: `GMAIL_MAX_PER_TICK` (20) è per
  casella **per ciclo**, e il ciclo gira ogni 5': il tetto teorico è 5.760
  classificazioni per casella al giorno. Non esiste cap giornaliero.
  `monthlyCostUsd` (`packages/db/src/cost.ts:42`) **include già**
  `email_classify`, ma il gate del budget è applicato solo a fix
  (`apps/worker/src/pipeline/fix.ts:881-883`) e review: **la posta consuma il
  budget dei fix senza esserne frenata**, ed è un difetto a prescindere da
  questa fase.
- **Nessuna deduplica per conversazione**: `email_messages.thread_id` esiste
  (`schema.ts:3205`) ma la selezione dei pendenti non lo guarda
  (`classify.ts:988-993`): un thread da trenta messaggi paga trenta analisi.
- **Perimetro vuoto oggi significa «butta»**: `classify.ts:862-871` degrada a
  `ignored`. Con l'ammissione separata quello stato diventa normale e deve
  significare «da attribuire».
- **Promessa in UI da riscrivere**: `project-email-routes-section.tsx:17-22`
  dice all'utente che «un messaggio che nessuna regola riconosce non viene
  nemmeno scaricato da Gmail». Con l'ammissione per dominio non è più vero.

**Volume reale dichiarato dal maintainer**: 0–10 email al giorno per dominio,
quattro domini, quindi al massimo una quarantina di analisi al giorno. Questo
numero **decide il disegno**: nessuna pre-selezione semantica dei progetti
(sarebbe ottimizzazione prematura e richiederebbe descrizioni di progetto
scritte apposta), si passano tutti i progetti all'analisi. Le difese di costo
restano come rete di sicurezza, non come architettura.

## 2. Perimetro (deciso)

Dentro: ammissione d'istanza dai domini dei Workspace con esclusioni per la
posta automatica; attribuzione invariata nella configurazione ma separata
nella funzione; attribuzione dall'analisi quando nessuna regola combacia;
proposta di smistamento quando c'è un segnale ma nessun progetto; tetto
giornaliero per casella, gate di budget sulla posta, una analisi per
conversazione in una finestra.

Fuori: pre-selezione semantica dei progetti ed embedding delle descrizioni;
creazione di progetti da un'email (resta un'azione deliberata); modifiche al
calendario, che continua a usare le regole di progetto come oggi; app mobile.

## 3. Ammissione

- **Configurazione d'istanza** (`instance_settings`, admin):
  `email_admit_workspace_domains bool` (default **true**),
  `email_admission_deny_labels text[]` (default
  `{CATEGORY_PROMOTIONS,CATEGORY_SOCIAL,SPAM}`),
  `email_admission_deny_automated bool` (default **true**: scarta i messaggi
  con `List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk` o
  `Auto-Submitted` diverso da `no`).
- **Funzione pura** `admit(message, config)` in
  `packages/notifications/src/email-routing.ts`, separata da `matchRoutes`
  che resta la sola attribuzione. Esiti: `admitted` con il motivo
  (`workspace_domain` | `project_rule`), oppure `rejected` con il motivo
  (`denied_label` | `automated` | `no_match`). Un'email è ammessa se il
  mittente **o un destinatario in copia** appartiene a un dominio di un
  Workspace registrato, oppure se una regola di progetto combacia (così i
  domini dei clienti esterni continuano ad ammettere come prima). Le
  esclusioni vincono sempre sull'ammissione.
- **Nel poller**: al posto di `if (!preFilter.inScope) continue` va
  `if (!admit(...).admitted) continue`; l'attribuzione (`matchRoutes`) resta
  dove è, dopo il download. I domini arrivano da
  `GoogleAccountCredentials.domains` (una riga in `credentials.ts`, zero
  query); la configurazione d'istanza si legge una volta per tick accanto
  alle regole.
- **Header**: `DEFAULT_METADATA_HEADERS` guadagna i quattro header della
  posta automatica; `EmailForRouting` li porta.

## 4. Attribuzione e smistamento

- Le regole di progetto restano **identiche** per l'utente. Cambia solo che
  non decidono più l'ingresso.
- **Nessuna regola combacia**: il messaggio viene ammesso con
  `scope_project_ids` vuoto e la classificazione lo tratta come «da
  attribuire», passando **tutti i progetti dell'istanza** come candidati (con
  il contesto già capato a dieci righe per progetto). Il costo triplica il
  prompt su una quarantina di messaggi al giorno: accettabile e misurato.
- **Tre esiti**, tutti già rappresentabili con gli stati esistenti:
  1. nessun segnale → `ignored`, nessuna notifica. Invariato.
  2. segnale e progetto attribuito dall'analisi → il fan-out della fase 6b
     crea i figli e le proposte normali.
  3. **segnale ma nessun progetto** → nasce una **proposta di smistamento**
     sul messaggio: riassume il segnale e chiede a quale progetto appartiene.
     Le opzioni sono i progetti suggeriti dall'analisi (fino a tre) più
     «nessuno di questi», che archivia.
- La proposta di smistamento **vive sul padre**, usando
  `email_messages.proposal_notification_id`, che dopo il fan-out è rimasto
  libero per la posta. Nessuna tabella nuova, nessuno stato nuovo: il padre
  va in `proposed` senza figli.
- **`choose_project` torna viva**, ed è il motivo per cui in fase 6b è stata
  solo deprecata e non rimossa: sulla proposta di smistamento attribuisce il
  messaggio, lo rimette in coda di classificazione e da lì nascono le
  proposte vere. Sulle proposte figlie resta deprecata come deciso.
- «Nessuno di questi» chiude il messaggio come `ignored` con l'esito
  registrato, così la pagina Posta mostra che è stato smistato e scartato,
  non semplicemente ignorato.

## 5. Difese di costo

- **Tetto giornaliero per casella**: `GMAIL_MAX_PER_DAY` (default 200,
  0 = nessun tetto), contato dai run di classificazione delle ultime
  ventiquattro ore per quella casella (una query per casella per tick,
  join fra `agent_runs` e `email_messages`). Raggiunto il tetto, la
  classificazione si ferma per quella casella e lo dice nel log; i messaggi
  restano `new` e vengono ripresi il giorno dopo.
- **Gate di budget**: prima di classificare, la stessa verifica del budget
  mensile che usano i fix. Superato il tetto, la classificazione si ferma con
  una riga di log esplicita. Chiude il difetto per cui la posta erodeva il
  budget dei fix senza esserne frenata.
- **Una analisi per conversazione**: `GMAIL_THREAD_COOLDOWN_MINUTES`
  (default 60, 0 = disattivato). Un messaggio il cui thread ha già avuto una
  classificazione nella finestra viene saltato e resta `new`; il ciclo passa
  al successivo, così un thread attivo non blocca la coda.
- Nessuno di questi tetti è pensato per mordere col volume dichiarato: sono
  reti di sicurezza contro una stima sbagliata o una casella inattesa.

## 6. Interfaccia, privacy, test e deploy

- **Impostazioni → Google**: nuova sezione «Posta ammessa» con
  l'interruttore dei domini dei Workspace, le esclusioni e i tetti; visibile
  a tutti, modificabile dagli admin, con l'elenco dei domini ammessi
  ricavato dai Workspace registrati.
- **Sezione Posta del progetto**: la copy cambia. Non più «solo ciò che una
  regola riconosce viene letto», ma «queste regole decidono a quale progetto
  va un'email già ammessa; l'ammissione si configura in Impostazioni →
  Google». Il testo che dichiara cosa viene scaricato va riscritto per dire
  il vero, ed è la parte non tecnica più importante della fase.
- **Test**: `admit` (dominio del mittente, dominio in copia, regola di
  progetto, etichetta esclusa, header di posta automatica, precedenza delle
  esclusioni, interruttore spento = comportamento di prima); poller (nessun
  download per i messaggi non ammessi, header nuovi richiesti senza chiamate
  in più); classificazione con perimetro vuoto e tutti i progetti; i tre
  esiti; proposta di smistamento (creazione, `choose_project` che attribuisce
  e riaccoda, «nessuno di questi» che archivia, nessuna interferenza con i
  figli della 6b); tetto giornaliero, gate di budget, cooldown per thread;
  retention che non pota un messaggio con una proposta di smistamento aperta;
  parità i18n.
- **Deploy**: migrazione 0071 (sole colonne su `instance_settings`; nessun
  enum, nessuna tabella, nessun kind nuovo); rebuild server, worker e caddy;
  env nuove opzionali (`GMAIL_MAX_PER_DAY`, `GMAIL_THREAD_COOLDOWN_MINUTES`).
  **Rollback**: spegnere `email_admit_workspace_domains` riporta al
  comportamento della fase 6 senza toccare le immagini; `GMAIL_POLL_MINUTES=0`
  resta la strada innocua; scendere di immagine sul server è sicuro (nessun
  kind nuovo, nessun valore aggiunto a un enum).
