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

  // --- notify.* — messaggi di notifica (frasi plain, senza markup) ---
  "notify.ticketCreated":
    "New ticket #{ticketNumber} — {ticketTitle} ({projectName}, {source}).",
  "notify.prOpened": "PR opened for #{ticketNumber} — {ticketTitle}.",
  "notify.prClosed":
    "PR closed without merging — ticket reopened: #{ticketNumber} — {ticketTitle}.",
  "notify.jobHeld":
    "#{ticketNumber} awaiting review — {ticketTitle} ({type}, effort {effort}/5).",
  "notify.planReview":
    "Plan awaiting approval — #{ticketNumber} — {ticketTitle} ({projectName}).",
  "notify.jobFailed": "AI fix failed on #{ticketNumber} — {ticketTitle}: {error}.",

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

  // --- notify.* ---
  "notify.ticketCreated":
    "Nuovo ticket #{ticketNumber} — {ticketTitle} ({projectName}, {source}).",
  "notify.prOpened": "PR aperta per #{ticketNumber} — {ticketTitle}.",
  "notify.prClosed":
    "PR chiusa senza merge — ticket riaperto: #{ticketNumber} — {ticketTitle}.",
  "notify.jobHeld":
    "#{ticketNumber} in attesa di revisione — {ticketTitle} ({type}, effort {effort}/5).",
  "notify.planReview":
    "Piano in attesa di approvazione — #{ticketNumber} — {ticketTitle} ({projectName}).",
  "notify.jobFailed": "Fix AI fallito su #{ticketNumber} — {ticketTitle}: {error}.",

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
