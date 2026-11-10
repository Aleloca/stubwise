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
  // Inviare fuori.
  "sendMail",
  "sendEmail",
  "postWebhook",
  "replyToCustomer",
];

describe("mai nel catalogo delle azioni di Claude (sorgente)", () => {
  const files = sources();
  it("i moduli ci sono (il test non gira a vuoto)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.path.endsWith("catalog.ts"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("execute.ts"))).toBe(true);
  });

  it.each(NEVER)("nessun modulo nomina %s", (name) => {
    // Il turno della chat EMETTE il token del turno: è il solo caso lecito.
    const offenders = files.filter(
      (f) => new RegExp(`\\b${name}\\b`).test(f.code) && !(name === "issueChatToolToken" && f.path.endsWith("turn.ts")),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
