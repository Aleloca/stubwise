// apps/worker/src/sessions/owners.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestDb, type TestDb, seedTicket } from "@stubwise/db/testing";
import { agentSessions, aiJobs, type Db } from "@stubwise/db";
import { FakeAgentRunner } from "../agent/fake.js";
import { aiJobSession, envSecretsOf, sessionOption } from "./owners.js";

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
