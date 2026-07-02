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
  "comment.planProposed": "Proposed plan (awaiting approval):",
  "comment.planApproved": "Plan approved — execution in progress",
  "comment.planRejected": "Plan rejected — replanning in progress",
  "comment.reportFooter": "Generated automatically by Stubwise AI for ticket #{number}.",
  "comment.reportMissing":
    "The agent did not generate a report ({filename} missing). Review the PR diff.",
  "comment.budgetHeld":
    "Cost budget exceeded ({scope}): spent ${spent} of ${limit}. The fix is on hold; start it manually to override.",
  "comment.providersLimitHeld":
    "All AI providers reached their rate/usage limit. The job will need to be retried after the limit resets.",
  // Verdetti della PR Review automatica postati come commento AI (niente
  // emoji DI VERDETTO ✅/⚠️ nel testo, convenzione condivisa con
  // notify.verdict.*; il 🔎 è il prefisso neutro della feature, non un verdetto).
  "comment.reviewVerdict.approve": "🔎 **PR Review** — approval suggested ({url})",
  "comment.reviewVerdict.requestChanges": "🔎 **PR Review** — changes requested ({url})",
  "comment.reviewTicketBody": "Automatic review of pull request {url} (branch `{branch}`).",

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
  "notify.jobFailed": "AI fix failed on {ref} — {ticketTitle}: {error}. {link}",
  "notify.budgetHeld":
    "Budget exceeded ({scope}) — {ref} {ticketTitle} ({projectName}): spent ${spent} of ${limit} limit. Job on hold; start it manually to override. {link}",
  "notify.reviewCompleted":
    "PR review completed for {ref} — {ticketTitle} ({projectName}): {verdict}. {link}",
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

  // --- report.* — header delle sezioni del report ---
  "report.investigation": "Investigation process",
  "report.rootCause": "Root cause",
  "report.solution": "Solution",
  "report.rationale": "Rationale",

  // --- plan.* — label delle sezioni del piano di fix ---
  "plan.rootCause": "Root cause",
  "plan.filesToChange": "File/function to change",
  "plan.changeToApply": "Change to apply",
  "plan.regressionTest": "Regression test to add",
  "plan.testCommands": "Test commands to run",
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
  "comment.planProposed": "Piano proposto (in attesa di approvazione):",
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
  // Verdetti della PR Review automatica (vedi nota in `en`).
  "comment.reviewVerdict.approve": "🔎 **PR Review** — approvazione suggerita ({url})",
  "comment.reviewVerdict.requestChanges": "🔎 **PR Review** — modifiche richieste ({url})",
  "comment.reviewTicketBody": "Review automatica della pull request {url} (branch `{branch}`).",

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
  "notify.jobFailed": "Fix AI fallito su {ref} — {ticketTitle}: {error}. {link}",
  "notify.budgetHeld":
    "Budget superato ({scope}) — {ref} {ticketTitle} ({projectName}): spesi ${spent} sul limite di ${limit}. Job in pausa; avvialo manualmente per forzare. {link}",
  "notify.reviewCompleted":
    "Review della PR completata per {ref} — {ticketTitle} ({projectName}): {verdict}. {link}",
  "notify.scopeTicket": "ticket",
  "notify.scopeMonthly": "mensile",
  "notify.verdict.approve": "approvazione suggerita",
  "notify.verdict.requestChanges": "modifiche richieste",
  "notify.costSuffix": " (costo ${cost})",
  "notify.linkOpen": "Apri",
  "notify.linkReview": "Rivedi",
  "notify.linkPr": "Vedi PR",
  "notify.linkTicket": "Ticket",

  // --- report.* ---
  "report.investigation": "Processo di indagine",
  "report.rootCause": "Causa radice",
  "report.solution": "Soluzione",
  "report.rationale": "Motivazione",

  // --- plan.* ---
  "plan.rootCause": "Causa radice",
  "plan.filesToChange": "File/funzione da modificare",
  "plan.changeToApply": "Modifica da applicare",
  "plan.regressionTest": "Test di regressione da aggiungere",
  "plan.testCommands": "Comandi di test da eseguire",
};

/** Catalogo per lingua. Mappato per `t()`/`languageName()`. */
export const catalogs = { en, it } as const;
