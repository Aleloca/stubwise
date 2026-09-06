/**
 * Cataloghi di traduzione dei testi GENERATI DAL BACKEND di Stubwise.
 *
 * DB-free e privi di logica: solo stringhe con segnaposto `{param}` interpolati
 * da `t()` in `./index.ts`. Coprono SOLO i testi prodotti dal backend (commenti
 * AI sui ticket, messaggi di notifica, header/label dei report), raggruppati per
 * area con prefisso (`comment.*`, `notify.*`, `report.*`/`plan.*`).
 *
 * I testi `it` sono quelli ATTUALMENTE hard-coded nel codice (webhooks/tickets
 * lato server, triage/fix/prompts lato worker, format lato notifications); gli
 * `en` ne sono la traduzione. I due oggetti DEVONO avere lo STESSO insieme di
 * chiavi: la parità è verificata da un test.
 */

/** Catalogo di una lingua: chiave piatta → template con segnaposto `{param}`. */
export type Catalog = Record<string, string>;

/** Testi inglesi (traduzione dei testi `it`). Sorgente di fallback di `t()`. */
export const en: Catalog = {
  // --- comment.* — commenti AI/sistema postati sul ticket ---
  "comment.prMerged": "PR merged: {url} — ticket closed automatically",
  "comment.prClosed":
    "PR closed without merging: {url} — ticket reopened, relaunch the fix whenever you want",
  "comment.fixReady": "Automatic fix ready: {url}",
  "comment.triageHeld":
    "AI triage: type={type}, effort={effortLabel} ({effort}/5). Automation not started (auto-fix disabled for this type, or effort above the threshold of {threshold}). You can start the fix manually.",
  "comment.triageSkip": "AI triage: skipping this ticket — {reason}",
  "comment.triageDuplicate": 'AI triage: duplicate of #{number} — "{title}"',
  "comment.backlogDeviated":
    "AI triage: type {type}. It does not enter the fix pipeline: moved to the discovery backlog for collection and refinement.",
  "comment.backlogIntake": 'Moved to the discovery backlog: "{title}".',
  "comment.planProposed": "Proposed plan (awaiting approval):",
  "comment.agentQuestion":
    "The AI needs a decision to continue planning (question {round}). Answer from your inbox or from this ticket.",
  "comment.agentQuestionRecommended": "recommended",
  "comment.agentQuestionAnswered":
    "{actor} answered the AI question (question {round}): {answer}",
  "comment.planApproved": "Plan approved — execution in progress",
  "comment.planRejected": "Plan rejected — replanning in progress",
  "comment.reportFooter": "Generated automatically by Stubwise AI for ticket #{number}.",
  "comment.reportMissing":
    "The agent did not generate a report ({filename} missing). Review the PR diff.",
  "comment.budgetHeld":
    "Cost budget exceeded ({scope}): spent ${spent} of ${limit}. The fix is on hold; start it manually to override.",
  "comment.providersLimitHeld":
    "All AI providers reached their rate/usage limit. The job will need to be retried after the limit resets.",
  "comment.limitResumed":
    "The provider usage limit has reset: the job was requeued automatically.",
  // Verdetti della PR Review automatica postati come commento AI (niente
  // emoji DI VERDETTO ✅/⚠️ nel testo, convenzione condivisa con
  // notify.verdict.*; il 🔎 è il prefisso neutro della feature, non un verdetto).
  "comment.reviewVerdict.approve": "🔎 **PR Review** — approval suggested ({url})",
  "comment.reviewVerdict.requestChanges": "🔎 **PR Review** — changes requested ({url})",
  "comment.reviewTicketBody": "Automatic review of pull request {url} (branch `{branch}`).",
  // Sezione "Impatto sul codice" appesa al commento di review: dato
  // DETERMINISTICO calcolato sul knowledge graph (mai prodotto dall'agente).
  // I conteggi sono in forma `etichetta: N` per restare corretti anche al
  // singolare (il catalogo non ha regole di plurale).
  "comment.reviewImpact.title": "**Code impact** (computed from the code graph)",
  "comment.reviewImpact.files":
    "Files touched: {inGraph} in the graph, {outside} outside it — symbols touched: {nodes}",
  "comment.reviewImpact.communities": "Areas crossed: {list}",
  "comment.reviewImpact.communityEntry": "{name} (files: {files}, symbols: {nodes})",
  "comment.reviewImpact.godNodes": "Highly connected symbols touched: {list}",
  "comment.reviewImpact.godNodeEntry": "`{label}` (degree {degree})",

  // --- backlog.* — messaggi `system` nella chat di una voce del backlog ---
  "backlog.mergedFromTicket": "New feedback integrated from ticket #{number}.",
  "backlog.mergedManual": "New feedback integrated (manually submitted idea).",
  "backlog.deepDiveDone": 'Technical analysis completed on repository "{repo}".',
  "backlog.codeSessionStarted": 'Code analysis session started on repository "{repo}".',
  "backlog.codeSessionClosed": "Code analysis session closed.",
  "backlog.codeSessionExpired": "Code analysis session closed due to inactivity.",
  "backlog.codeTurnError":
    "The code analysis run failed. Please try sending your message again.",

  // --- effort.* — etichette della scala di sforzo 1–5 (allineate alle label
  // della web UI, namespace `badges.effort`). Usate nei commenti AI del triage.
  "effort.1": "Trivial",
  "effort.2": "Small",
  "effort.3": "Medium",
  "effort.4": "Large",
  "effort.5": "Very large",

  // --- notify.* — messaggi di notifica.
  // `{ref}` è il riferimento al ticket (`#42`), reso con il markup del formato
  // (Slack `*#42*`, Discord `**#42**`, generico `#42`); `{link}` è il/i link
  // già reso/i nel markup del formato (vuoto per il payload generico, che porta
  // gli URL come campi); `{cost}` è il suffisso costo localizzato o vuoto.
  // Un'UNICA chiave per evento serve tutti i formati: vedi `format.ts`.
  "notify.ticketCreated":
    "New ticket {ref} — {ticketTitle} ({projectName}, {source}). {link}",
  "notify.prOpened": "PR opened for {ref} — {ticketTitle}{cost}. {link}",
  "notify.prClosed":
    "PR closed without merging — ticket reopened: {ref} — {ticketTitle}. {link}",
  "notify.jobHeld":
    "{ref} awaiting review — {ticketTitle} ({type}, effort {effort}/5). {link}",
  "notify.planReview":
    "Plan awaiting approval — {ref} — {ticketTitle} ({projectName}). {link}",
  // Domanda dell'AI durante la pianificazione: `{question}` è il testo posto
  // dall'agente (le opzioni vivono nel payload, non nella frase).
  "notify.awaitingInput":
    "AI has a question on {ref} — {ticketTitle}: {question} {link}",
  "notify.jobFailed": "AI fix failed on {ref} — {ticketTitle}: {error}. {link}",
  "notify.budgetHeld":
    "Budget exceeded ({scope}) — {ref} {ticketTitle} ({projectName}): spent ${spent} of ${limit} limit. Job on hold; start it manually to override. {link}",
  "notify.reviewCompleted":
    "PR review completed for {ref} — {ticketTitle} ({projectName}): {verdict}. {link}",
  // Unico evento SENZA ticket: niente {ref}, il {link} porta alla pagina Docs.
  "notify.docsLimitPaused":
    "Docs generation paused for {repositoryName} ({projectName}): provider usage limit reached. It will resume automatically. {link}",
  // Monitoraggio server: eventi SENZA ticket; il {link} porta alla pagina del
  // server. `{condition}` è l'etichetta localizzata della condizione (vedi
  // notify.monitorCondition.*), `{detail}` la descrizione già leggibile.
  "notify.monitorAlert":
    "Server alert on {serverName} ({condition}): {detail}. {link}",
  "notify.monitorRecovered":
    "{serverName} recovered ({condition}): {detail}. {link}",
  // Pulse proattivo: evento SENZA ticket ancorato al PROGETTO, il {link} porta
  // al suo backlog. I titoli delle proposte NON stanno nella frase — sono le
  // opzioni della domanda, che ogni superficie rende a modo suo.
  // `{idleDays}` è in forma `etichetta: N` (stessa convenzione di
  // comment.reviewImpact.*) perché il catalogo non ha regole di plurale: "for 1
  // days" sarebbe sbagliato, e `0` è il fallback previsto quando i giorni di
  // fermo non si riescono a calcolare.
  "notify.pulse":
    "No work in progress on {project} (days idle: {idleDays}): there are proposals in the backlog. {link}",
  // Brief settimanale (fase 5): informativo, nessuna azione richiesta. Le date
  // sono ISO `YYYY-MM-DD` — il catalogo non formatta date, e un brief va letto
  // nella stessa forma su web, Slack e webhook.
  "notify.brief":
    "Weekly brief for {project} ({periodStart} → {periodEnd}): {headline} {link}",
  // Etichette delle condizioni di monitoraggio (interpolate in notify.monitor*).
  "notify.monitorCondition.offline": "offline",
  "notify.monitorCondition.cpu": "CPU",
  "notify.monitorCondition.mem": "memory",
  "notify.monitorCondition.disk": "disk",
  "notify.monitorCondition.checkDown": "check down",
  // Etichette dello scope del budget (interpolate in `notify.budgetHeld`).
  "notify.scopeTicket": "ticket",
  "notify.scopeMonthly": "monthly",
  // Verdetti della review PR (interpolati in `notify.reviewCompleted`).
  "notify.verdict.approve": "approval suggested",
  "notify.verdict.requestChanges": "changes requested",
  // Suffisso costo (anteposto allo spazio: la frase ha già lo spazio prima).
  "notify.costSuffix": " (cost ${cost})",
  // Etichette dei link (rese nel markup del formato attorno all'URL).
  "notify.linkOpen": "Open",
  "notify.linkReview": "Review",
  "notify.linkPr": "View PR",
  "notify.linkTicket": "Ticket",
  "notify.linkDocs": "Docs",
  "notify.linkServer": "Server",
  "notify.linkBacklog": "Backlog",
  "notify.linkRoadmap": "Roadmap",
  // Etichette dei BOTTONI dell'inbox (DM Slack e, un domani, altre superfici
  // interattive). Testi brevi: Slack tronca oltre i 75 caratteri.
  "notify.action.approvePlan": "Approve plan",
  "notify.action.rejectPlan": "Reject",
  "notify.action.relaunch": "Relaunch",
  "notify.action.answer": "Answer",
  "notify.action.handled": "Mark as handled",
  "notify.action.open": "Open",
  "notify.action.snooze": "Snooze…",
  "notify.action.snooze1h": "1 hour",
  "notify.action.snoozeTomorrow": "Tomorrow",
  "notify.action.snooze3d": "3 days",
  // Testi delle INTERAZIONI dall'inbox su Slack (bottoni del DM): messaggi
  // effimeri d'errore, note di stato appese al messaggio dopo l'azione e
  // etichette del modal di rifiuto del piano.
  //
  // LINGUA: gli errori e la nota della PROPRIA copia sono nella lingua di chi
  // ha premuto (`users.language`); la nota delle copie ALTRUI in quella di
  // ciascun destinatario. `{actor}` è l'email di chi ha agito.
  "notify.inbox.notLinked":
    "Your Slack account is not linked to Stubwise: ask an administrator to link it in the settings.",
  "notify.inbox.errNotFound": "Notification not found.",
  "notify.inbox.errForbidden": "Administrators only.",
  "notify.inbox.errInvalidAction": "This action is not available on this notification.",
  "notify.inbox.errAlreadyHandled": "Already handled by {actor}.",
  "notify.inbox.errAlreadyHandledUnknown": "This notification has already been handled.",
  // Gemelli di `errAlreadyHandled` per la sola DOMANDA dell'agente: "handled"
  // è il lessico delle decisioni generiche, su una domanda l'esito che conta è
  // che qualcuno ha già RISPOSTO. Stesse parole del web
  // (`question:errors.alreadyAnswered`), che è l'altra superficie della stessa
  // corsa persa.
  "notify.inbox.errAlreadyAnswered": "Already answered by {actor}.",
  "notify.inbox.errAlreadyAnsweredUnknown": "Already answered by someone else.",
  "notify.inbox.errJobInFlight": "A job for this ticket is already running ({status}).",
  "notify.inbox.errPlanNotPending": "No plan is awaiting approval.",
  "notify.inbox.errInvalidAnswer": "That answer is not valid for this question.",
  "notify.inbox.errQuestionNotPending": "No question is awaiting an answer.",
  "notify.inbox.errProposalStale":
    "That proposal is no longer available: it has already been taken care of.",
  "notify.inbox.errRunNotStarted":
    "Ticket created, but the run did not start. Launch it from the ticket.",
  "notify.inbox.errFailed": "The action could not be completed. Try again from Stubwise.",
  // Note di stato: sostituiscono i bottoni sul messaggio già deciso.
  "notify.inbox.notePlanApproved": "✅ Plan approved by {actor}",
  "notify.inbox.notePlanRejected": "🚫 Plan rejected by {actor}",
  "notify.inbox.noteRelaunched": "🔁 Fix relaunched by {actor}",
  "notify.inbox.noteAnswered": "💬 Answer from {actor}: {answer}",
  "notify.inbox.noteHandled": "✅ Marked as handled by {actor}",
  "notify.inbox.noteSnoozed": "⏰ Snoozed until {until}",
  // Note del "Procedi" del pulse: quattro esiti, quattro frasi. Le prime due
  // NON sono intercambiabili — col piano già pronto il run aspetta subito
  // un'approvazione, senza piano la pianificazione parte e si fermerà dopo.
  //
  // Le tre che hanno un ticket ne portano il NUMERO perché il DM è TESTO: chi
  // lo rilegge non ha una card da cui cliccare. Nell'inbox il link arriva
  // invece dai dati — la decisione valorizza `notifications.ticket_id` (vedi
  // `proceedWithProposal`) — e queste frasi non ne sono l'unica traccia.
  "notify.inbox.notePulseStartedApproval":
    "▶️ {actor} started «{title}» as #{number} — waiting for plan approval",
  "notify.inbox.notePulseStartedPlanning":
    "▶️ {actor} started «{title}» as #{number} — planning under way, it will stop for approval",
  "notify.inbox.notePulseTicketOnly":
    "▶️ {actor} turned «{title}» into ticket #{number} — the run did not start, launch it by hand",
  "notify.inbox.notePulseStale": "🗄️ «{title}» has already been taken care of",
  // Pulse SOSTITUITO da uno più recente sullo stesso progetto (la scrive il
  // poller del worker, non un'azione umana): nessun `{actor}`, perché non l'ha
  // deciso nessuno. Serve a togliere i bottoni da un DM le cui proposte non
  // esistono più.
  "notify.inbox.notePulseReplaced": "🔄 Replaced by a newer set of proposals",
  // Modal di rifiuto del piano (il titolo Slack tronca oltre i 24 caratteri).
  "notify.inbox.rejectTitle": "Reject plan",
  "notify.inbox.rejectSubmit": "Reject",
  "notify.inbox.rejectClose": "Cancel",
  "notify.inbox.rejectLabel": "Instructions for replanning (optional)",
  "notify.inbox.rejectPlaceholder": "What is wrong with the plan? The AI will use this to replan.",
  // Domanda dell'agente sul DM: bottone del testo libero (le altre etichette
  // sono le opzioni stesse, che scrive l'agente) e modal che lo raccoglie.
  // "consigliata" NON ha una chiave sua: è la stessa parola del commento sul
  // ticket (`comment.agentQuestionRecommended`), e una sola traduzione evita
  // che le due superfici dicano cose diverse della stessa opzione.
  "notify.inbox.answerOther": "Other…",
  "notify.inbox.answerTitle": "Answer the AI",
  "notify.inbox.answerSubmit": "Send",
  "notify.inbox.answerClose": "Cancel",
  "notify.inbox.answerLabel": "Your answer",
  "notify.inbox.answerPlaceholder": "Answer in your own words: the AI resumes planning from here.",

  // --- push.title.* — TITOLO della notifica push (Fase 4) ---
  //
  // Il corpo della push è la frase `notify.*` già esistente: qui c'è solo il
  // titolo, che sul telefono è una riga in grassetto sopra al corpo e viene
  // TRONCATO dal sistema operativo dopo poche decine di caratteri. Vanno quindi
  // tenuti corti e senza dettagli: il dettaglio è nel corpo, che si legge
  // subito sotto.
  //
  // La chiave è `push.title.<kind>` col kind LETTERALE (punti compresi), così
  // la corrispondenza con `NotificationKind` si legge a occhio. Non c'è nulla
  // da ricordare quando nasce un kind: `PUSH_TITLE_KEY` in
  // `@stubwise/notifications` è un `Record<NotificationKind, string>` — senza
  // la voce nuova non compila — e un test verifica che ogni chiave esista in
  // ENTRAMBI i cataloghi (senza, `t()` farebbe fallback sull'inglese e un
  // telefono italiano riceverebbe un titolo in inglese senza che nulla
  // protesti).
  "push.title.ticket.created": "New ticket",
  "push.title.job.pr_opened": "PR ready",
  "push.title.job.pr_closed": "PR closed",
  "push.title.job.held": "Fix waiting for a go-ahead",
  "push.title.job.plan_review": "Plan to approve",
  "push.title.job.budget_held": "Budget exceeded",
  "push.title.review.completed": "PR review ready",
  "push.title.job.failed": "Job failed",
  "push.title.docs.limit_paused": "Docs paused",
  "push.title.monitor.alert": "Server alert",
  "push.title.monitor.recovered": "Server recovered",
  "push.title.job.awaiting_input": "A question is waiting for you",
  // L'unico titolo con un segnaposto: il pulse arriva a progetto fermo, e
  // nominarlo è ciò che distingue due pulse nella stessa notifica di sistema.
  "push.title.project.pulse": "Where to pick up on {project}",
  "push.title.project.brief": "This week on {project}",

  // --- report.* — header delle sezioni del report ---
  "report.investigation": "Investigation process",
  "report.rootCause": "Root cause",
  "report.solution": "Solution",
  "report.rationale": "Rationale",

  // --- summary.* — riassunti "in breve" per NON tecnici (fase 5).
  // La lingua NON è cablata nel builder del prompt: sta qui, dentro il testo
  // stesso delle istruzioni, che è già scritto nella lingua di destinazione.
  // È la correzione dell'errore del report giornaliero ("Scrivi in ITALIANO"
  // dentro il prompt, qualunque fosse la lingua d'istanza). ---
  "summary.plan.instructions":
    "Write exactly THREE sentences in English, for a person who does NOT read code: (1) what changes for whoever uses the product, (2) which parts of the product it touches, (3) what stays out of scope. No code, no file names, no technical jargon. Reply with the three sentences only, no preamble and no title.",
  "summary.pr.instructions":
    "Write exactly TWO sentences in English, for a person who does NOT read code: the first says what this pull request does for whoever uses the product, the second says in plain words what the automatic review concluded. No code, no file names, no technical jargon, and do not repeat the verdict keyword as-is. Reply with the two sentences only, no preamble and no title.",
  "summary.truncated": "[input truncated for length]",

  // --- plan.* — label delle sezioni del piano di fix ---
  "plan.rootCause": "Root cause",
  "plan.filesToChange": "File/function to change",
  "plan.changeToApply": "Change to apply",
  "plan.regressionTest": "Regression test to add",
  "plan.testCommands": "Test commands to run",
  "plan.decisions": "Decisions and assumptions",
};

/** Testi italiani: copia esatta dei testi attualmente hard-coded nel backend. */
export const it: Catalog = {
  // --- comment.* ---
  "comment.prMerged": "PR mergiata: {url} — ticket chiuso automaticamente",
  "comment.prClosed":
    "PR chiusa senza merge: {url} — ticket riaperto, rilancia il fix quando vuoi",
  "comment.fixReady": "Fix automatico pronto: {url}",
  "comment.triageHeld":
    "Triage AI: tipo={type}, effort={effortLabel} ({effort}/5). Automazione non avviata (auto-fix disattivato per questo tipo, oppure effort sopra la soglia di {threshold}). Puoi avviare il fix manualmente.",
  "comment.triageSkip": "Triage AI: salto questo ticket — {reason}",
  "comment.triageDuplicate": 'Triage AI: duplicato di #{number} — "{title}"',
  "comment.backlogDeviated":
    "Triage AI: tipo {type}. Non entra nella pipeline di fix: spostato nel backlog di discovery per raccolta e raffinamento.",
  "comment.backlogIntake": 'Spostato nel backlog di discovery: "{title}".',
  "comment.planProposed": "Piano proposto (in attesa di approvazione):",
  "comment.agentQuestion":
    "L'AI ha bisogno di una decisione per continuare la pianificazione (domanda {round}). Rispondi dall'inbox o da questo ticket.",
  "comment.agentQuestionRecommended": "consigliata",
  "comment.agentQuestionAnswered":
    "{actor} ha risposto alla domanda dell'AI (domanda {round}): {answer}",
  "comment.planApproved": "Piano approvato — esecuzione in corso",
  "comment.planRejected": "Piano rifiutato — ripianificazione in corso",
  "comment.reportFooter":
    "Generato automaticamente da Stubwise AI per il ticket #{number}.",
  "comment.reportMissing":
    "Il report non è stato generato dall'agente ({filename} mancante). Esaminare il diff della PR.",
  "comment.budgetHeld":
    "Budget di costo superato ({scope}): spesi ${spent} sul limite di ${limit}. Il fix è in pausa; avvialo manualmente per forzare.",
  "comment.providersLimitHeld":
    "Tutti i provider AI hanno raggiunto il limite di rate/usage. Il job dovrà essere ritentato dopo il reset del limite.",
  "comment.limitResumed":
    "Il limite di utilizzo del provider è rientrato: il job è stato riaccodato automaticamente.",
  // Verdetti della PR Review automatica (vedi nota in `en`).
  "comment.reviewVerdict.approve": "🔎 **PR Review** — approvazione suggerita ({url})",
  "comment.reviewVerdict.requestChanges": "🔎 **PR Review** — modifiche richieste ({url})",
  "comment.reviewTicketBody": "Review automatica della pull request {url} (branch `{branch}`).",
  // Sezione "Impatto sul codice" del commento di review (vedi nota in `en`).
  "comment.reviewImpact.title": "**Impatto sul codice** (calcolato dal grafo del codice)",
  "comment.reviewImpact.files":
    "File toccati: {inGraph} nel grafo, {outside} fuori — simboli toccati: {nodes}",
  "comment.reviewImpact.communities": "Aree attraversate: {list}",
  "comment.reviewImpact.communityEntry": "{name} (file: {files}, simboli: {nodes})",
  "comment.reviewImpact.godNodes": "Simboli molto connessi toccati: {list}",
  "comment.reviewImpact.godNodeEntry": "`{label}` (grado {degree})",

  // --- backlog.* (messaggi `system` nella chat di una voce del backlog) ---
  "backlog.mergedFromTicket": "Nuovo feedback integrato dal ticket #{number}.",
  "backlog.mergedManual": "Nuovo feedback integrato (idea proposta manualmente).",
  "backlog.deepDiveDone": 'Analisi tecnica completata sul repository "{repo}".',
  "backlog.codeSessionStarted": 'Sessione di analisi sul codice avviata sul repository "{repo}".',
  "backlog.codeSessionClosed": "Sessione di analisi sul codice chiusa.",
  "backlog.codeSessionExpired": "Sessione di analisi sul codice chiusa per inattività.",
  "backlog.codeTurnError":
    "L'analisi del codice non è riuscita. Riprova a inviare il messaggio.",

  // --- effort.* (etichette italiane della scala di sforzo, = EFFORT_LABELS) ---
  "effort.1": "Banale",
  "effort.2": "Piccolo",
  "effort.3": "Medio",
  "effort.4": "Grande",
  "effort.5": "Molto grande",

  // --- notify.* (vedi note sui placeholder {ref}/{link}/{cost} in `en`) ---
  "notify.ticketCreated":
    "Nuovo ticket {ref} — {ticketTitle} ({projectName}, {source}). {link}",
  "notify.prOpened": "PR aperta per {ref} — {ticketTitle}{cost}. {link}",
  "notify.prClosed":
    "PR chiusa senza merge — ticket riaperto: {ref} — {ticketTitle}. {link}",
  "notify.jobHeld":
    "{ref} in attesa di revisione — {ticketTitle} ({type}, effort {effort}/5). {link}",
  "notify.planReview":
    "Piano in attesa di approvazione — {ref} — {ticketTitle} ({projectName}). {link}",
  "notify.awaitingInput":
    "L'AI ha una domanda su {ref} — {ticketTitle}: {question} {link}",
  "notify.jobFailed": "Fix AI fallito su {ref} — {ticketTitle}: {error}. {link}",
  "notify.budgetHeld":
    "Budget superato ({scope}) — {ref} {ticketTitle} ({projectName}): spesi ${spent} sul limite di ${limit}. Job in pausa; avvialo manualmente per forzare. {link}",
  "notify.reviewCompleted":
    "Review della PR completata per {ref} — {ticketTitle} ({projectName}): {verdict}. {link}",
  // Unico evento SENZA ticket: niente {ref}, il {link} porta alla pagina Docs.
  "notify.docsLimitPaused":
    "Generazione Docs in pausa per {repositoryName} ({projectName}): limite di utilizzo del provider raggiunto. Riprenderà da sola. {link}",
  "notify.monitorAlert":
    "Alert sul server {serverName} ({condition}): {detail}. {link}",
  "notify.monitorRecovered":
    "{serverName} tornato su ({condition}): {detail}. {link}",
  "notify.pulse":
    "Nessun lavoro in corso su {project} (giorni di fermo: {idleDays}): ci sono proposte nel backlog. {link}",
  "notify.brief":
    "Brief settimanale di {project} ({periodStart} → {periodEnd}): {headline} {link}",
  "notify.monitorCondition.offline": "offline",
  "notify.monitorCondition.cpu": "CPU",
  "notify.monitorCondition.mem": "memoria",
  "notify.monitorCondition.disk": "disco",
  "notify.monitorCondition.checkDown": "check down",
  "notify.scopeTicket": "ticket",
  "notify.scopeMonthly": "mensile",
  "notify.verdict.approve": "approvazione suggerita",
  "notify.verdict.requestChanges": "modifiche richieste",
  "notify.costSuffix": " (costo ${cost})",
  "notify.linkOpen": "Apri",
  "notify.linkReview": "Rivedi",
  "notify.linkPr": "Vedi PR",
  "notify.linkTicket": "Ticket",
  "notify.linkDocs": "Docs",
  "notify.linkServer": "Server",
  "notify.linkBacklog": "Backlog",
  "notify.linkRoadmap": "Roadmap",
  "notify.action.approvePlan": "Approva il piano",
  "notify.action.rejectPlan": "Rifiuta",
  "notify.action.relaunch": "Rilancia",
  "notify.action.answer": "Rispondi",
  "notify.action.handled": "Segna come gestita",
  "notify.action.open": "Apri",
  "notify.action.snooze": "Rinvia…",
  "notify.action.snooze1h": "1 ora",
  "notify.action.snoozeTomorrow": "Domani",
  "notify.action.snooze3d": "3 giorni",
  // Interazioni dell'inbox su Slack (vedi le note in `en`).
  "notify.inbox.notLinked":
    "Il tuo account Slack non è collegato a Stubwise: chiedi a un amministratore di collegarlo dalle impostazioni.",
  "notify.inbox.errNotFound": "Notifica non trovata.",
  "notify.inbox.errForbidden": "Riservato agli amministratori.",
  "notify.inbox.errInvalidAction": "Questa azione non è disponibile su questa notifica.",
  "notify.inbox.errAlreadyHandled": "Già gestita da {actor}.",
  "notify.inbox.errAlreadyHandledUnknown": "Questa notifica è già stata gestita.",
  "notify.inbox.errAlreadyAnswered": "Ha già risposto {actor}.",
  "notify.inbox.errAlreadyAnsweredUnknown": "Ha già risposto qualcun altro.",
  "notify.inbox.errJobInFlight": "C'è già un job in corso per questo ticket ({status}).",
  "notify.inbox.errPlanNotPending": "Nessun piano in attesa di approvazione.",
  "notify.inbox.errInvalidAnswer": "Questa risposta non è valida per questa domanda.",
  "notify.inbox.errQuestionNotPending": "Nessuna domanda in attesa di risposta.",
  "notify.inbox.errProposalStale":
    "Questa proposta non è più disponibile: è già stata presa in carico.",
  "notify.inbox.errRunNotStarted": "Ticket creato, ma il run non è partito. Lancialo dal ticket.",
  "notify.inbox.errFailed": "Azione non riuscita. Riprova da Stubwise.",
  "notify.inbox.notePlanApproved": "✅ Piano approvato da {actor}",
  "notify.inbox.notePlanRejected": "🚫 Piano rifiutato da {actor}",
  "notify.inbox.noteRelaunched": "🔁 Fix rilanciato da {actor}",
  "notify.inbox.noteAnswered": "💬 Risposta di {actor}: {answer}",
  "notify.inbox.noteHandled": "✅ Segnata come gestita da {actor}",
  "notify.inbox.noteSnoozed": "⏰ Rinviata fino a {until}",
  "notify.inbox.notePulseStartedApproval":
    "▶️ {actor} ha avviato «{title}» come #{number} — in attesa dell'approvazione del piano",
  "notify.inbox.notePulseStartedPlanning":
    "▶️ {actor} ha avviato «{title}» come #{number} — pianificazione avviata, si fermerà per l'approvazione",
  "notify.inbox.notePulseTicketOnly":
    "▶️ {actor} ha creato il ticket #{number} per «{title}» — il run non è partito, va lanciato a mano",
  "notify.inbox.notePulseStale": "🗄️ «{title}» è già stata presa in carico",
  "notify.inbox.notePulseReplaced": "🔄 Sostituita da proposte più recenti",
  "notify.inbox.rejectTitle": "Rifiuta il piano",
  "notify.inbox.rejectSubmit": "Rifiuta",
  "notify.inbox.rejectClose": "Annulla",
  "notify.inbox.rejectLabel": "Istruzioni per la ripianificazione (opzionale)",
  "notify.inbox.rejectPlaceholder":
    "Cosa non va nel piano? L'AI userà queste indicazioni per ripianificare.",
  "notify.inbox.answerOther": "Altro…",
  "notify.inbox.answerTitle": "Rispondi all'AI",
  "notify.inbox.answerSubmit": "Invia",
  "notify.inbox.answerClose": "Annulla",
  "notify.inbox.answerLabel": "La tua risposta",
  "notify.inbox.answerPlaceholder":
    "Rispondi con parole tue: l'AI riprende la pianificazione da qui.",

  // --- push.title.* — TITOLO della notifica push (vedi il catalogo `en`) ---
  "push.title.ticket.created": "Nuovo ticket",
  "push.title.job.pr_opened": "PR pronta",
  "push.title.job.pr_closed": "PR chiusa",
  "push.title.job.held": "Fix in attesa di via libera",
  "push.title.job.plan_review": "Piano da approvare",
  "push.title.job.budget_held": "Budget superato",
  "push.title.review.completed": "Review della PR pronta",
  "push.title.job.failed": "Fix AI fallito",
  "push.title.docs.limit_paused": "Docs in pausa",
  "push.title.monitor.alert": "Allarme su un server",
  "push.title.monitor.recovered": "Server tornato su",
  "push.title.job.awaiting_input": "Una domanda ti aspetta",
  "push.title.project.pulse": "Da dove ripartire su {project}",
  "push.title.project.brief": "Questa settimana su {project}",

  // --- report.* ---
  "report.investigation": "Processo di indagine",
  "report.rootCause": "Causa radice",
  "report.solution": "Soluzione",
  "report.rationale": "Motivazione",

  // --- summary.* (vedi la nota nel catalogo `en`) ---
  "summary.plan.instructions":
    "Scrivi esattamente TRE frasi in ITALIANO, per una persona che NON legge codice: (1) cosa cambia per chi usa il prodotto, (2) quali parti del prodotto tocca, (3) cosa resta fuori. Niente codice, niente nomi di file, niente gergo tecnico. Rispondi SOLO con le tre frasi, senza preamboli e senza titolo.",
  "summary.pr.instructions":
    "Scrivi esattamente DUE frasi in ITALIANO, per una persona che NON legge codice: la prima dice cosa fa questa pull request per chi usa il prodotto, la seconda dice a parole cosa ha concluso la review automatica. Niente codice, niente nomi di file, niente gergo tecnico, e non ripetere la parola chiave del verdetto così com'è. Rispondi SOLO con le due frasi, senza preamboli e senza titolo.",
  "summary.truncated": "[input troncato per lunghezza]",

  // --- plan.* ---
  "plan.rootCause": "Causa radice",
  "plan.filesToChange": "File/funzione da modificare",
  "plan.changeToApply": "Modifica da applicare",
  "plan.regressionTest": "Test di regressione da aggiungere",
  "plan.testCommands": "Comandi di test da eseguire",
  "plan.decisions": "Decisioni e assunzioni",
};

/** Catalogo per lingua. Mappato per `t()`/`languageName()`. */
export const catalogs = { en, it } as const;
