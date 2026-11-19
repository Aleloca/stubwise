import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MAI NEL CATALOGO (chat con Claude, fetta 3; design «Mai nel catalogo»): ciò
 * che è un gesto delle persone non passa MAI dalle azioni di Claude — né come
 * azione, né come inverso. Il controllo è sul SORGENTE, come
 * `decisions-never-ai.test.ts` e `neverInCatalog.test.ts` del prototipo, e
 * cerca RIFERIMENTI DI CODICE (identificatori, import), non parole nei
 * commenti: i commenti di questi moduli nominano apposta ciò che è escluso.
 *
 * I moduli: l'esecutore e il catalogo del server, le sue rotte, il ponte e il
 * server MCP della chat nel worker.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  here,
  join(here, "..", "routes", "claude-actions.ts"),
  join(here, "..", "routes", "claude-conversations.ts"),
  // Area 4, fetta 3: @Claude nella Chat (la chiamata, le risposte, le domande).
  join(here, "..", "chat", "claude.ts"),
  join(here, "..", "..", "..", "worker", "src", "claude-chat"),
  join(here, "..", "..", "..", "worker", "src", "chat-mcp"),
];

function sources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const root of ROOTS) {
    const files = root.endsWith(".ts") ? [root] : readdirSync(root).map((f) => join(root, f));
    for (const path of files) {
      if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
      out.push({ path, code: stripComments(readFileSync(path, "utf8")) });
    }
  }
  return out;
}

/** Il codice senza commenti (blocco e riga): le parole nei commenti non contano. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Le scritture che restano gesti delle persone (i nomi delle funzioni dei servizi). */
const NEVER = [
  // Il piano: approvare, rifiutare, pre-approvare, revocare.
  "resolvePlan",
  "preApprovePlan",
  "revokePlanApproval",
  // Rispondere a una domanda dell'agente o a una richiesta di decisione.
  "answerQuestion",
  "answerDecision",
  "answerGoogleProposal",
  // Mergiare, rilasciare.
  "releasePullRequest",
  // Il registro decisioni.
  "projectDecisions",
  "recordDecision",
  "insertDecision",
  // Segreti, token, inviti, reset.
  "revealCredential",
  "createPatForUser",
  "issueChatToolToken",
  "createInvite",
  "passwordResetTokens",
  // Inviare fuori. `fillMailBody` SALVA una bozza (un gesto confermato, B):
  // mandarla resta un gesto della persona, mai di Claude.
  "sendMail",
  "sendEmail",
  "sendDraftLater",
  "sendDraft",
  "retrySend",
  // Scrivere sul calendario (area 6, F4): sempre un gesto della persona, mai di
  // Claude — gli inviti partono da Google verso chiunque, anche fuori (Q6).
  "createCalendarEvent",
  "editCalendarEvent",
  "moveCalendarEvent",
  "respondCalendarEvent",
  "deleteCalendarEventRow",
  "setCalendarEventProject",
  "insertCalendarEvent",
  "patchCalendarEvent",
  "deleteCalendarEvent",
  "respondToCalendarEvent",
  "postWebhook",
  "replyToCustomer",
  // Area 9, F7 (design «Mai nel catalogo»): i gesti dell'amministrazione che
  // restano delle persone. PAT e inviti, i reset, il ruolo d'istanza,
  // disattivare ed eliminare una persona, eliminare un progetto; i segreti
  // (creare un webhook ne mostra il segreto, ruotarlo, la chiave
  // d'ingestione, il segreto del webhook git, la cassaforte).
  "personalAccessTokens",
  "createUserWithPat",
  "revokeMobilePats",
  // (La tabella `invites` no: «invites» è una parola del contratto del prompt.)
  "applyInviteGrants",
  "inviteTokenOf",
  "issuePasswordResetToken",
  "revokePendingResetTokens",
  "setInstanceRole",
  "deactivateUser",
  "reactivateUser",
  "deleteUser",
  "deleteArchivedProject",
  "createWebhook",
  "deleteWebhook",
  "rotateWebhookSecret",
  "regenerateWebhookSecret",
  "regenerateIngestionKey",
  "vaultSettings",
  "vaultPersonKeys",
  "vaultPersonKeySeals",
  // Area 10, F2 (`docs/invariants/automations.md`): Claude scrive solo BOZZE.
  // Accendere, pubblicare, mettere in pausa, duplicare un'automazione, avviarne
  // un'esecuzione o deciderci sopra restano gesti delle persone.
  "publishAutomation",
  "activateAutomation",
  "pauseAutomation",
  "duplicateAutomation",
  "startManualRun",
  "approveRun",
  "rejectRun",
  "controlRun",
  "chooseRunProject",
  "runTestClaude",
  "estimateTest",
];

/** Area 10, F2: le rotte delle automazioni che accendono o fanno partire qualcosa. */
const AUTOMATION_LIVE_ROUTES = [
  "/automations/:code/publish",
  "/automations/:code/activate",
  "/automations/:code/pause",
  "/automations/:code/duplicate",
  "/automations/:code/runs",
  "/automations/:code/test",
];

/**
 * Area 9, F7: le rotte che danno o cambiano un segreto. Nessun modulo le
 * nomina, nemmeno come `route` di una voce (il percorso sta in una stringa:
 * qui si cerca nel codice senza commenti, stringhe comprese).
 */
const SECRET_ROUTES = ["/ingestion-key", "/webhook-secret", "/secret", "/identity-secret"];

describe("mai nel catalogo delle azioni di Claude (sorgente)", () => {
  const files = sources();
  it("i moduli ci sono (il test non gira a vuoto)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.path.endsWith("catalog.ts"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("execute.ts"))).toBe(true);
  });

  it.each(NEVER)("nessun modulo nomina %s", (name) => {
    // Il turno della chat EMETTE il token del turno: è il solo caso lecito.
    // Area 10, F1: il ponte nomina `sendEmail` come TIPO di passo di
    // un'automazione nella proiezione di `read_automation` (ne passa solo
    // l'oggetto): si toglie quella riga sola, il resto del file conta.
    const codeOf = (f: { path: string; code: string }) =>
      name === "sendEmail" && f.path.endsWith(join("claude-chat", "bridge.ts")) ? f.code.replace('  sendEmail: ["subject"],', "") : f.code;
    const offenders = files.filter(
      (f) => new RegExp(`\\b${name}\\b`).test(codeOf(f)) && !(name === "issueChatToolToken" && f.path.endsWith("turn.ts")),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it.each(AUTOMATION_LIVE_ROUTES)("nessun modulo nomina la rotta %s", (route) => {
    expect(files.filter((f) => f.code.includes(route)).map((f) => f.path)).toEqual([]);
  });

  it.each(SECRET_ROUTES)("nessun modulo nomina la rotta %s", (route) => {
    const offenders = files.filter((f) => new RegExp(`${route.replace(/[/-]/g, (c) => `\\${c}`)}(?![a-z-])`).test(f.code));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
