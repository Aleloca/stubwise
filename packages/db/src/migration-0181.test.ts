import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuns, instanceSigningKeys, serverAnalyses, serverCommands, serverEpisodes, serverOperationApprovals, servers, serverSshAccess } from "./schema.js";
import { expectSqlState, seedRepository, seedTicket, startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0181 (14 nov 2026, area 8, fetta 4b): le operazioni sui server.
 * I CHECK sono la difesa nel DB delle regole di
 * docs/invariants/server-operations.md: un comando che CAMBIA esiste solo con
 * un'approvazione e solo via agente; via SSH solo letture; azioni fuori
 * dall'insieme chiuso non si scrivono nemmeno a mano.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function server() {
  const [s] = await t.db.insert(servers).values({ name: `s-${randomUUID()}`, keyHash: randomUUID() }).returning();
  return s!;
}
const later = () => new Date(Date.now() + 600_000);

describe("0181: i guardiani nel DB", () => {
  it("una lettura dell'agente senza approvazione sì; un `change` senza approvazione NO", async () => {
    const s = await server();
    await t.db.insert(serverCommands).values({ serverId: s.id, action: "container.logs", kind: "read", expiresAt: later() });
    await expectSqlState(t.db.insert(serverCommands).values({ serverId: s.id, action: "container.restart", kind: "change", expiresAt: later() }), "23514");
  });

  it("un `change` con un'approvazione e il passo: sì; via SSH mai un change; azioni fuori elenco mai", async () => {
    const s = await server();
    const { projectId } = await seedRepository(t.db);
    const { ticketId } = await seedTicket(t.db, { projectId });
    const [a] = await t.db.insert(serverOperationApprovals).values({ serverId: s.id, taskId: ticketId, steps: [{ action: "container.start", params: { container: "web" }, why: "fermo" }] }).returning();
    await t.db.insert(serverCommands).values({ serverId: s.id, action: "container.start", kind: "change", approvalId: a!.id, stepIndex: 0, expiresAt: later() });
    await expectSqlState(t.db.insert(serverCommands).values({ serverId: s.id, via: "ssh", action: "disk", kind: "change", approvalId: a!.id, stepIndex: 0, expiresAt: later() }), "23514");
    for (const action of ["image.pull", "container.exec", "compose.up", "shell"]) {
      await expectSqlState(t.db.insert(serverCommands).values({ serverId: s.id, action, kind: "read", expiresAt: later() }), "23514");
    }
    // Via SSH solo le letture dell'elenco.
    await t.db.insert(serverCommands).values({ serverId: s.id, via: "ssh", action: "disk", kind: "read", expiresAt: later() });
    await expectSqlState(t.db.insert(serverCommands).values({ serverId: s.id, via: "ssh", action: "container.restart", kind: "read", expiresAt: later() }), "23514");
    // L'approvazione di un comando non si cancella sotto di lui.
    await expectSqlState(t.db.delete(serverOperationApprovals).where(eq(serverOperationApprovals.id, a!.id)), "23503");
  });

  it("un'analisi per episodio; una chiave di firma attiva; l'SSH solo `read`", async () => {
    const s = await server();
    const [ep] = await t.db.insert(serverEpisodes).values({ serverId: s.id, severity: "down" }).returning();
    await t.db.insert(serverAnalyses).values({ serverId: s.id, episodeId: ep!.id });
    await expectSqlState(t.db.insert(serverAnalyses).values({ serverId: s.id, episodeId: ep!.id }), "23505");
    await t.db.insert(instanceSigningKeys).values({ publicKey: "pub", privateKeyEncrypted: "enc" });
    await expectSqlState(t.db.insert(instanceSigningKeys).values({ publicKey: "pub2", privateKeyEncrypted: "enc2" }), "23505");
    await expectSqlState(t.db.insert(serverSshAccess).values({ serverId: s.id, kind: "write" as never, host: "h", publicKey: "p", privateKeyEncrypted: "e" }), "23514");
  });

  it("le operazioni AI e i kind delle sessioni nuovi passano i CHECK; il kind della diagnosi esiste", async () => {
    for (const operation of ["server_analysis", "server_fix_plan"] as const) {
      await t.db.insert(agentRuns).values({ operation, model: "sonnet" } as typeof agentRuns.$inferInsert);
    }
    const kinds = await t.db.execute(sql`select 1 from pg_enum where enumlabel = 'server.diagnosis_ready'`);
    expect(kinds).toHaveLength(1);
    const checks = await t.db.execute<{ def: string }>(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agent_sessions_kind_chk'`);
    expect(checks[0]!.def).toContain("server_analysis");
    expect(checks[0]!.def).toContain("server_fix");
  });
});
