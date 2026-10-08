// apps/worker/src/sessions/owners.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDb, seedRepository, seedTicket } from "@stubwise/db/testing";
import {
  agentSessions,
  aiJobs,
  backlogItems,
  backlogJobs,
  docGenerations,
  googleAccounts,
  googleWorkspaces,
  users,
  type Db,
} from "@stubwise/db";
import { INTERACTIVE_SEGMENTS } from "@stubwise/shared";
import { FakeAgentRunner } from "../agent/fake.js";
import type { AgentRunSession } from "../agent/runner.js";
import { StreamingClaudeRunner, type SessionHooks } from "../agent/streaming-cli.js";
import {
  aiJobSession,
  backlogItemSession,
  backlogJobSession,
  dailyReportSession,
  docGenerationSession,
  docUpdateSession,
  emailMessageSession,
  envSecretsOf,
  projectBriefSession,
  sessionOption,
} from "./owners.js";
import { createSegmentSink } from "./store.js";

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => t.stop());

describe("aiJobSession", () => {
  it("una sola sessione per job, col ticket, il job e il progetto, titolo «#N titolo»", async () => {
    // seedTicket restituisce { projectId, repositoryId, ticketId }: numero 1, titolo "Ticket di test".
    const { projectId, ticketId } = await seedTicket(t.db);
    const [job] = await t.db.insert(aiJobs).values({ ticketId }).returning();
    const a = await aiJobSession(t.db, { id: job!.id, ticketId }, "plan");
    const b = await aiJobSession(t.db, { id: job!.id, ticketId }, "execute", ["s3cr3t-value"]);
    expect(a!.sessionId).toBe(b!.sessionId);
    expect(a!.secrets).toBeUndefined();
    expect(b!.label).toBe("execute");
    expect(b!.secrets).toEqual(["s3cr3t-value"]);
    const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, a!.sessionId));
    expect(row!.ticketId).toBe(ticketId);
    expect(row!.aiJobId).toBe(job!.id);
    expect(row!.projectId).toBe(projectId);
    expect(row!.title).toBe("#1 Ticket di test");
  });

  it("fail-open: con il database che lancia restituisce undefined, non lancia", async () => {
    const broken = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "select" || prop === "insert") {
          return () => {
            throw new Error("db giù");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        aiJobSession(broken, { id: crypto.randomUUID(), ticketId: crypto.randomUUID() }, "triage"),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("db giù");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sessionOption", () => {
  const session = { sessionId: "s1", label: "execute" as const };

  it("runner storico: `make` non viene chiamata e il run non riceve il campo", async () => {
    const make = vi.fn(async () => session);
    expect(await sessionOption(new FakeAgentRunner(), make)).toEqual({});
    expect(make).not.toHaveBeenCalled();
  });

  it("runner che registra: { session }; sessione non creata: {}", async () => {
    const runner = new FakeAgentRunner({ recordsSessions: true });
    expect(await sessionOption(runner, async () => session)).toEqual({ session });
    expect(await sessionOption(runner, async () => undefined)).toEqual({});
  });

  it("fail-open: se `make` lancia, {} e una riga di log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await sessionOption(new FakeAgentRunner({ recordsSessions: true }), async () => {
        throw new Error("boom");
      });
      expect(out).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("envSecretsOf", () => {
  it("unisce i valori di TUTTI i repo, senza doppioni", () => {
    expect(
      envSecretsOf([
        { envProcessEnv: { A: "valore-repo-uno", SHARED: "condiviso-1234" } },
        { envProcessEnv: { B: "valore-repo-due", SHARED: "condiviso-1234" } },
        { envProcessEnv: {} },
      ]).sort(),
    ).toEqual(["condiviso-1234", "valore-repo-due", "valore-repo-uno"]);
    expect(envSecretsOf([])).toEqual([]);
  });
});

/** Utente + Workspace + casella Google (stesso setup di google/classify.test.ts). */
async function seedMailbox(db: Db): Promise<{ ownerUserId: string; accountId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `u-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" })
    .returning({ id: users.id });
  const [workspace] = await db
    .insert(googleWorkspaces)
    .values({ name: "Acme", domains: ["acme.com"], clientId: "client-id", clientSecretEncrypted: "blob" })
    .returning({ id: googleWorkspaces.id });
  const [account] = await db
    .insert(googleAccounts)
    .values({
      userId: user!.id,
      workspaceId: workspace!.id,
      email: `casella-${randomUUID()}@acme.com`,
      googleSub: `sub-${randomUUID()}`,
      refreshTokenEncrypted: "blob",
    })
    .returning({ id: googleAccounts.id });
  return { ownerUserId: user!.id, accountId: account!.id };
}

async function sessionRow(sessionId: string) {
  const [row] = await t.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
  return row!;
}

describe("sessioni della posta", () => {
  it("la sessione di un messaggio ha come unico lettore il proprietario della casella", async () => {
    const { ownerUserId, accountId } = await seedMailbox(t.db);
    const messageId = randomUUID();
    const s = await emailMessageSession(t.db, { id: messageId, accountId, subject: "Fattura" });
    const row = await sessionRow(s!.sessionId);
    expect(row.kind).toBe("email_message");
    expect(row.ownerKey).toBe(`email_message:${messageId}`);
    expect(row.mailboxOwnerUserId).toBe(ownerUserId);
    expect(row.title).toBe("Fattura");
    expect(s!.label).toBe("email_classify");
    // Run su una dir vuota: nessun .env, nessun segreto da oscurare.
    expect(s!.secrets).toBeUndefined();
  });

  it("una casella che non si risolve non crea la sessione (mai una posta senza proprietario)", async () => {
    const messageId = randomUUID();
    expect(
      await emailMessageSession(t.db, { id: messageId, accountId: randomUUID(), subject: "x" }),
    ).toBeUndefined();
    expect(
      await t.db.select().from(agentSessions).where(eq(agentSessions.ownerKey, `email_message:${messageId}`)),
    ).toHaveLength(0);
  });

  it("senza oggetto: titolo neutro, proprietario comunque presente", async () => {
    const { ownerUserId, accountId } = await seedMailbox(t.db);
    const s = await emailMessageSession(t.db, { id: randomUUID(), accountId, subject: null });
    const row = await sessionRow(s!.sessionId);
    expect(row.title).toBe("(senza oggetto)");
    expect(row.mailboxOwnerUserId).toBe(ownerUserId);
  });
});

describe("sessioni dei Docs", () => {
  it("una generazione Docs prende progetto e titolo dal repository, e lega doc_generation_id", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const [gen] = await t.db.insert(docGenerations).values({ repositoryId }).returning();
    const s = await docGenerationSession(t.db, { id: gen!.id, repositoryId });
    const row = await sessionRow(s!.sessionId);
    expect(row.kind).toBe("doc_generation");
    expect(row.ownerKey).toBe(`doc_generation:${gen!.id}`);
    expect(row.projectId).toBe(projectId);
    expect(row.docGenerationId).toBe(gen!.id);
    expect(row.title).toBe("Docs · Repository di test");
    expect(s!.label).toBe("docs");
  });

  it("un aggiornamento automatico ha una sessione sua, senza generazione", async () => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const jobId = randomUUID();
    const s = await docUpdateSession(t.db, { id: jobId, repositoryId });
    const row = await sessionRow(s!.sessionId);
    expect(row.ownerKey).toBe(`doc_update:${jobId}`);
    expect(row.kind).toBe("doc_generation");
    expect(row.docGenerationId).toBeNull();
    expect(row.projectId).toBe(projectId);
    expect(s!.label).toBe("docs");
  });

  it("i nodi di una generazione chiedono la sessione insieme: UNA sola riga", async () => {
    const { repositoryId } = await seedRepository(t.db);
    const [gen] = await t.db.insert(docGenerations).values({ repositoryId }).returning();
    const all = await Promise.all(
      Array.from({ length: 4 }, () => docGenerationSession(t.db, { id: gen!.id, repositoryId })),
    );
    expect(new Set(all.map((s) => s!.sessionId)).size).toBe(1);
    expect(
      await t.db.select().from(agentSessions).where(eq(agentSessions.docGenerationId, gen!.id)),
    ).toHaveLength(1);
  });
});

/**
 * Finto CLI stream-json che resta a metà turno finché non compare il file
 * `GATE` (path nell'env): così due processi sono vivi INSIEME nel momento in
 * cui il test guarda `live_segment_ids`.
 */
const GATED_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let started = false;
rl.on("line", () => {
  if (started) return;
  started = true;
  out({ type: "system", subtype: "init", capabilities: [] });
  const t = setInterval(() => {
    if (!fs.existsSync(process.env.GATE)) return;
    clearInterval(t);
    out({ type: "assistant", message: { content: [{ type: "text", text: "nodo fatto" }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "nodo fatto", total_cost_usd: 0.01, session_id: "s" });
  }, 20);
});
rl.on("close", () => process.exit(0));
`;

describe("Docs: due nodi in parallelo nella stessa sessione (sola lettura)", () => {
  it("una sessione, entrambi i segmenti vivi insieme, elenco vuoto alla fine, mai registrati come interattivi", async () => {
    expect(INTERACTIVE_SEGMENTS.has("docs")).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "stw-docs-par-"));
    try {
      const bin = join(root, "claude");
      await writeFile(bin, GATED_CLI, "utf8");
      await chmod(bin, 0o755);
      const gate = join(root, "GATE");
      const register = vi.fn(() => () => {});
      const interactiveFlags: boolean[] = [];
      const hooks: SessionHooks = {
        openSegment: (session: AgentRunSession, segmentId: string, interactive: boolean) => {
          interactiveFlags.push(interactive);
          return createSegmentSink(t.db, session, segmentId, interactive, { flushMs: 10 });
        },
        register,
      };
      const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, extraEnv: { GATE: gate } });
      const { repositoryId } = await seedRepository(t.db);
      const [gen] = await t.db.insert(docGenerations).values({ repositoryId }).returning();
      // Come due handler (explore + synthesize) che partono insieme.
      const node = () =>
        sessionOption(runner, () => docGenerationSession(t.db, { id: gen!.id, repositoryId })).then((opt) =>
          runner.run({ cwd: root, prompt: "documenta", maxTurns: 3, timeoutMs: 20_000, ...opt }).then(
            (r) => ({ r, opt }),
          ),
        );
      const both = Promise.all([node(), node()]);

      // Entrambi vivi INSIEME.
      let live: string[] = [];
      for (let i = 0; i < 200 && live.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 25));
        const rows = await t.db.select().from(agentSessions).where(eq(agentSessions.docGenerationId, gen!.id));
        live = rows[0]?.liveSegmentIds ?? [];
      }
      expect(live).toHaveLength(2);
      const [during] = await t.db.select().from(agentSessions).where(eq(agentSessions.docGenerationId, gen!.id));
      expect(during!.activeSegmentLabel).toBe("docs");
      expect(during!.activeSegmentInteractive).toBe(false);

      await writeFile(gate, "go");
      const results = await both;
      expect(results.map((x) => x.r.output)).toEqual(["nodo fatto", "nodo fatto"]);
      expect(results[0]!.opt.session!.sessionId).toBe(results[1]!.opt.session!.sessionId);

      const rows = await t.db.select().from(agentSessions).where(eq(agentSessions.docGenerationId, gen!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.liveSegmentIds).toEqual([]);
      expect(rows[0]!.activeSegmentId).toBeNull();
      // Sola lettura: nessun processo registrato per gli interventi.
      expect(register).not.toHaveBeenCalled();
      expect(interactiveFlags).toEqual([false, false]);
    } finally {
      if (existsSync(root)) await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("sessioni di backlog, brief e report", () => {
  it("una voce di backlog: una sessione per voce, con la label del run", async () => {
    const { projectId } = await seedRepository(t.db);
    const [item] = await t.db
      .insert(backlogItems)
      .values({ projectId, title: "Idea", document: "doc", source: "manual" })
      .returning();
    const a = await backlogItemSession(t.db, { id: item!.id, projectId, title: "Idea" }, "deep_dive");
    const b = await backlogItemSession(t.db, { id: item!.id, projectId, title: "Idea" }, "chat_turn");
    expect(a!.sessionId).toBe(b!.sessionId);
    expect(b!.label).toBe("chat_turn");
    const row = await sessionRow(a!.sessionId);
    expect(row.kind).toBe("backlog_item");
    expect(row.ownerKey).toBe(`backlog_item:${item!.id}`);
    expect(row.backlogItemId).toBe(item!.id);
    expect(row.projectId).toBe(projectId);
    expect(row.title).toBe("Idea");
  });

  it("un job di intake senza voce: sessione del job", async () => {
    const { projectId } = await seedRepository(t.db);
    const [job] = await t.db
      .insert(backlogJobs)
      .values({ projectId, kind: "intake", payload: { title: "x", body: "y" } })
      .returning();
    const s = await backlogJobSession(t.db, { id: job!.id, projectId }, "intake");
    const row = await sessionRow(s!.sessionId);
    expect(row.kind).toBe("backlog_job");
    expect(row.ownerKey).toBe(`backlog_job:${job!.id}`);
    expect(row.backlogJobId).toBe(job!.id);
    expect(row.title).toBe("Intake");
    expect(s!.label).toBe("intake");
  });

  it("brief settimanale e report giornaliero", async () => {
    const { projectId } = await seedRepository(t.db);
    const briefId = randomUUID();
    const brief = await projectBriefSession(t.db, { id: briefId, projectId });
    const briefRow = await sessionRow(brief!.sessionId);
    expect(briefRow.kind).toBe("project_brief");
    expect(briefRow.ownerKey).toBe(`project_brief:${briefId}`);
    expect(briefRow.title).toBe("Brief settimanale");
    expect(brief!.label).toBe("brief");

    const report = await dailyReportSession(t.db, { id: projectId, name: "Alfa" }, "2026-10-07");
    const reportRow = await sessionRow(report!.sessionId);
    expect(reportRow.kind).toBe("daily_report");
    expect(reportRow.ownerKey).toBe(`daily_report:${projectId}:2026-10-07`);
    expect(reportRow.title).toBe("Report 2026-10-07 · Alfa");
    expect(reportRow.projectId).toBe(projectId);
    expect(report!.label).toBe("daily_report");
  });
});

describe("AGENT_STREAMING=false: nessuna sessione per nessun proprietario nuovo", () => {
  const owners: Array<[string, (ids: { projectId: string; repositoryId: string; accountId: string; id: string }) => Promise<AgentRunSession | undefined>, (id: string, projectId: string) => string]> = [
    ["backlog_item", (x) => backlogItemSession(t.db, { id: x.id, projectId: x.projectId, title: "t" }, "estimate"), (id) => `backlog_item:${id}`],
    ["backlog_job", (x) => backlogJobSession(t.db, { id: x.id, projectId: x.projectId }, "intake"), (id) => `backlog_job:${id}`],
    ["email_message", (x) => emailMessageSession(t.db, { id: x.id, accountId: x.accountId, subject: "s" }), (id) => `email_message:${id}`],
    ["doc_generation", (x) => docGenerationSession(t.db, { id: x.id, repositoryId: x.repositoryId }), (id) => `doc_generation:${id}`],
    ["doc_update", (x) => docUpdateSession(t.db, { id: x.id, repositoryId: x.repositoryId }), (id) => `doc_update:${id}`],
    ["project_brief", (x) => projectBriefSession(t.db, { id: x.id, projectId: x.projectId }), (id) => `project_brief:${id}`],
    ["daily_report", (x) => dailyReportSession(t.db, { id: x.projectId, name: "p" }, x.id), (id, projectId) => `daily_report:${projectId}:${id}`],
  ];

  it.each(owners)("%s: col runner storico `make` non scrive nessuna riga", async (_name, make, key) => {
    const { projectId, repositoryId } = await seedRepository(t.db);
    const { accountId } = await seedMailbox(t.db);
    const id = randomUUID();
    const spy = vi.fn(() => make({ projectId, repositoryId, accountId, id }));
    expect(await sessionOption(new FakeAgentRunner(), spy)).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    expect(await t.db.select().from(agentSessions).where(eq(agentSessions.ownerKey, key(id, projectId)))).toHaveLength(0);
  });
});

describe("fail-open dei proprietari nuovi", () => {
  const broken = () =>
    new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === "select" || prop === "insert") {
          return () => {
            throw new Error("db giù");
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Db;

  it.each([
    ["email_message", (db: Db) => emailMessageSession(db, { id: randomUUID(), accountId: randomUUID(), subject: "s" })],
    ["doc_generation", (db: Db) => docGenerationSession(db, { id: randomUUID(), repositoryId: randomUUID() })],
    ["doc_update", (db: Db) => docUpdateSession(db, { id: randomUUID(), repositoryId: randomUUID() })],
    ["backlog_item", (db: Db) => backlogItemSession(db, { id: randomUUID(), projectId: randomUUID(), title: "t" }, "deep_dive")],
    ["backlog_job", (db: Db) => backlogJobSession(db, { id: randomUUID(), projectId: randomUUID() }, "intake")],
    ["project_brief", (db: Db) => projectBriefSession(db, { id: randomUUID(), projectId: randomUUID() })],
    ["daily_report", (db: Db) => dailyReportSession(db, { id: randomUUID(), name: "p" }, "2026-10-07")],
  ] as const)("%s: database che lancia → undefined e UNA riga di log", async (_n, make) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(make(broken())).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
