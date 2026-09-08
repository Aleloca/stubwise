import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentQuestions,
  aiJobs,
  backlogItems,
  emailMessages,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projectDecisions,
  users,
  type Db,
} from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { seedRepository, startTestDb } from "@stubwise/db/testing";
import { createTicket } from "../db/tickets.js";

/**
 * ⚠️ INVARIANTE DELLA FASE 5, VERIFICATA — **il registro decisioni non è mai
 * scritto dall'AI.**
 *
 * Le decisioni sono la fonte di verità sui FATTI compiuti da persone: le legge
 * la chat (come contesto), i Docs di progetto, il tool MCP e il brief
 * settimanale. Se una sola di quelle righe fosse prosa generata, tutto ciò che
 * ci si appoggia diventerebbe narrativa che cita sé stessa — e il brief, che è
 * narrativa dichiarata, sta esattamente in piedi perché il registro non lo è.
 *
 * Il test la verifica su DUE piani, perché nessuno dei due basta da solo:
 *
 *  - **a runtime**: `@anthropic-ai/sdk` — l'unica superficie AI raggiungibile
 *    dal server (`routes/chat-llm.ts`) — è mockato con delle spie, e i tre
 *    writer automatici girano davvero, contro un Postgres vero, fino a
 *    scrivere la loro riga. Le spie devono restare a zero;
 *  - **sul sorgente**: i quattro moduli del percorso non nominano nessun
 *    esecutore di agenti. Copre anche il caso che un domani il worker (dove
 *    vivono `runAgentText` e `runner.run`) diventasse importabile da qui.
 *
 * Chi aggiunge un "riassunto migliore" a una decisione fa fallire questo test.
 * È il punto: la riga giusta da cambiare non è questa, è quella scelta.
 */

const anthropicSpies = vi.hoisted(() => ({
  construct: vi.fn(),
  create: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicSpies.create, stream: anthropicSpies.stream };
    constructor(...args: unknown[]) {
      anthropicSpies.construct(...args);
    }
  },
}));

import { answerGoogleProposal } from "./google-proposal.js";
import { resolvePlan, type Actor } from "./jobs.js";
import { proceedWithProposal } from "./pulse.js";
import { answerQuestion } from "./questions.js";

let testDb: TestDb;
let db: Db;
let projectId: string;
let maintainer: Actor;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  ({ projectId } = await seedRepository(db));
  const [row] = await db
    .insert(users)
    .values({ email: `admin-${randomUUID()}@example.com`, passwordHash: "x", role: "admin" })
    .returning({ id: users.id, role: users.role });
  maintainer = { id: row!.id, role: row!.role };
}, 120_000);

afterAll(async () => {
  await testDb.stop();
});

async function seedTicket(title: string): Promise<string> {
  const ticket = await createTicket(db, {
    projectId,
    title,
    type: "bug",
    priority: "medium",
    source: "manual",
  });
  return ticket.id;
}

/** Nessuna delle spie AI è stata toccata da quando il test è iniziato. */
function expectNoAgentCalled(): void {
  expect(anthropicSpies.construct).not.toHaveBeenCalled();
  expect(anthropicSpies.create).not.toHaveBeenCalled();
  expect(anthropicSpies.stream).not.toHaveBeenCalled();
}

/** Le decisioni scritte per il ticket dato. */
async function decisionsOf(ticketId: string) {
  return db.select().from(projectDecisions).where(eq(projectDecisions.ticketId, ticketId));
}

describe("il registro decisioni non è mai scritto dall'AI — a runtime", () => {
  it("la risposta a una domanda scrive la decisione senza chiamare nessun agente", async () => {
    const ticketId = await seedTicket("Ticket con domanda");
    const [job] = await db
      .insert(aiJobs)
      .values({ ticketId, status: "awaiting_input", cliSessionId: "sess" })
      .returning({ id: aiJobs.id });
    await db.insert(agentQuestions).values({
      jobId: job!.id,
      ticketId,
      round: 1,
      question: "Quale formato per l'export?",
      options: [{ label: "CSV", consequence: "Nessuna dipendenza nuova" }, { label: "XLSX" }],
      allowFreeText: true,
    });

    expect(
      (await answerQuestion(db, { jobId: job!.id, actor: maintainer, answer: { optionIndex: 0 } }))
        .ok,
    ).toBe(true);

    expect(await decisionsOf(ticketId)).toHaveLength(1);
    expectNoAgentCalled();
  });

  it("l'approvazione del piano scrive la decisione senza chiamare nessun agente", async () => {
    const ticketId = await seedTicket("Ticket col piano");
    await db.insert(aiJobs).values({
      ticketId,
      status: "awaiting_plan_approval",
      planText: "## Piano\n1. Passo",
      // Il riassunto "in breve" ESISTE ed è generato: la decisione lo ignora.
      planSummary: "Riassunto scritto da un agente.",
      planApprovalRequired: true,
    });

    expect((await resolvePlan(db, { ticketId, actor: maintainer, mode: "execute" })).ok).toBe(true);

    const rows = await decisionsOf(ticketId);
    expect(rows).toHaveLength(1);
    // La prova che il riassunto generato non è entrato nel fatto registrato.
    expect(JSON.stringify(rows[0])).not.toContain("Riassunto scritto da un agente");
    expectNoAgentCalled();
  });

  it("il «Procedi» del pulse scrive la decisione senza chiamare nessun agente", async () => {
    const [item] = await db
      .insert(backlogItems)
      .values({
        projectId,
        title: "Ricerca full-text nell'archivio",
        source: "manual",
        status: "ready",
        document: "# Design\n\nCorpo.",
        urgency: "high",
        effort: 2,
      })
      .returning({ id: backlogItems.id, title: backlogItems.title });
    const [row] = await db
      .insert(notifications)
      .values({
        userId: maintainer.id,
        projectId,
        kind: "project.pulse",
        status: "open",
        event: {
          kind: "project.pulse",
          pulseId: randomUUID(),
          proposals: [{ backlogItemId: item!.id, title: item!.title }],
        },
      })
      .returning({ id: notifications.id });

    const result = await proceedWithProposal(db, {
      notificationId: row!.id,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await decisionsOf(result.ticketId)).toHaveLength(1);
    expectNoAgentCalled();
  });

  it("la conferma di una proposta Google registra la decisione senza chiamare nessun agente", async () => {
    const ticketId = await seedTicket("Ticket dalla posta");
    const [workspace] = await db
      .insert(googleWorkspaces)
      .values({
        name: "Acme",
        domains: ["acme.test"],
        clientId: "client-id",
        clientSecretEncrypted: "blob",
      })
      .returning({ id: googleWorkspaces.id });
    const [account] = await db
      .insert(googleAccounts)
      .values({
        userId: maintainer.id,
        workspaceId: workspace!.id,
        email: `mailbox-${randomUUID()}@acme.test`,
        googleSub: `sub-${randomUUID()}`,
        refreshTokenEncrypted: "blob",
      })
      .returning({ id: googleAccounts.id });
    const [message] = await db
      .insert(emailMessages)
      .values({
        accountId: account!.id,
        gmailMessageId: `m-${randomUUID()}`,
        threadId: `t-${randomUUID()}`,
        fromAddress: "laura@cliente.test",
        receivedAt: new Date(),
        projectId,
        status: "proposed",
      })
      .returning({ id: emailMessages.id });
    // Fase 6b: `answerGoogleProposal` legge/scrive ormai sul FIGLIO
    // (`email_proposals`), mai più su `email_messages` — vedi
    // `google-proposal.test.ts`. `proposal_notification_id` vive qui.
    const [emailProposal] = await db
      .insert(emailProposals)
      .values({
        emailMessageId: message!.id,
        projectId,
        status: "proposed",
        classification: { summary: "test", proposals: [], recommendedIndex: 0 },
      })
      .returning({ id: emailProposals.id });

    const proposalId = randomUUID();
    const [notification] = await db
      .insert(notifications)
      .values({
        userId: maintainer.id,
        projectId,
        kind: "google.proposal",
        status: "open",
        event: {
          kind: "google.proposal",
          proposalId,
          source: "email",
          messageUrl: "https://mail.google.com/mail/u/x/#all/t",
          signal: "decision",
          from: "Laura <laura@cliente.test>",
          subject: "Rinviamo il rilascio?",
          question: "Laura scrive a proposito di «Rinviamo il rilascio?». Come diamo seguito?",
          options: [
            { label: "Registra la decisione: Rinviare il rilascio" },
            { label: "Non fare nulla" },
          ],
          actions: [
            {
              type: "record_decision",
              projectId,
              ticketId,
              title: "Rinviare il rilascio",
              // Testo che, se finisse nel registro, farebbe fallire questo
              // stesso test: `answerGoogleProposal` NON lo deve mai usare.
              decision: "Testo generato dal modello, mai usato nel registro.",
            },
            { type: "ignore" },
          ],
          recommendedIndex: 0,
          allowFreeText: false,
        },
      })
      .returning({ id: notifications.id });
    await db
      .update(emailProposals)
      .set({ proposalNotificationId: notification!.id })
      .where(eq(emailProposals.id, emailProposal!.id));

    const result = await answerGoogleProposal(db, {
      notificationId: notification!.id,
      actor: maintainer,
      optionIndex: 0,
    });
    expect(result.ok).toBe(true);

    const rows = await decisionsOf(ticketId);
    expect(rows).toHaveLength(1);
    // La prova che la prosa del classificatore non è entrata nel fatto
    // registrato: solo `from`/`subject`/l'etichetta templata dell'opzione.
    expect(JSON.stringify(rows[0])).not.toContain("Testo generato dal modello");
    expectNoAgentCalled();
  });
});

describe("il registro decisioni non è mai scritto dall'AI — sul sorgente", () => {
  /**
   * Nomi che indicano un ESECUTORE di agenti, non un dato già scritto. Non c'è
   * `planSummary`: leggere quella colonna sarebbe lecito, è metterla in una
   * decisione che non lo è — e quello lo copre il test a runtime qui sopra.
   */
  const AGENT_MARKERS = [
    "@anthropic-ai/sdk",
    "runAgentText",
    "runner.run",
    "createRunner",
    "@stubwise/worker",
  ];

  const MODULES = [
    "../../../../packages/db/src/decisions.ts",
    "./questions.ts",
    "./jobs.ts",
    "./pulse.ts",
    // Fase 6, Task 11: l'esecuzione delle proposte Google (email + calendario)
    // scrive nel registro decisioni (`record_decision`) da un template i18n,
    // mai dal testo che il classificatore ha suggerito — vedi il docblock del
    // modulo.
    "./google-proposal.ts",
  ];

  it.each(MODULES)("%s non nomina nessun esecutore di agenti", async (relative) => {
    const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
    for (const marker of AGENT_MARKERS) {
      expect(source).not.toContain(marker);
    }
  });
});
