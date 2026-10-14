import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentSessions, backlogItemRevisions, backlogItems, backlogRefineSessions } from "@stubwise/db";
import { seedBacklogItem, startTestDb, type TestDb } from "@stubwise/db/testing";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  REFINE_MCP_SERVER_NAME,
  REFINE_TOOL_NAMES,
  REFINE_TOOLS,
  backlogRiskSchema,
  backlogUrgencySchema,
  effortSchema,
} from "@stubwise/shared";
import { buildRefineMcpServer } from "../../refine-mcp/server.js";
import { buildRefineMcpConfig, startRefineBridge, type RefineBridge } from "./bridge.js";

let t: TestDb;
let bridge: RefineBridge;
beforeAll(async () => { t = await startTestDb(); bridge = await startRefineBridge({ db: t.db }); }, 120_000);
afterAll(async () => { await bridge.close(); await t.stop(); });

async function seeded(status: "active" | "closed" = "active") {
  const { itemId } = await seedBacklogItem(t.db);
  await t.db.update(backlogItems).set({ document: "originale" }).where(eq(backlogItems.id, itemId));
  const [s] = await t.db.insert(agentSessions)
    .values({ ownerKey: `backlog_refine:${itemId}`, kind: "backlog_refine", title: "t", backlogItemId: itemId }).returning();
  await t.db.insert(backlogRefineSessions).values({
    itemId, agentSessionId: s!.id, status,
    lastActivityAt: new Date(Date.now() - 3_600_000),
    ...(status === "closed" ? { closedAt: new Date(), closedReason: "user" as const } : {}),
  });
  return { itemId, agentSessionId: s!.id };
}
const call = (tool: string, secret: string | null, body: unknown) =>
  fetch(`${bridge.url}/tools/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const itemOf = async (id: string) => (await t.db.select().from(backlogItems).where(eq(backlogItems.id, id)))[0]!;

describe("ponte dei tool di refinement", () => {
  it("ascolta solo su loopback", () => {
    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
  });

  it("set_design: scrive, preserva l'origine, salva la revisione, tocca l'attività e notifica la sessione", async () => {
    const { itemId, agentSessionId } = await seeded();
    const notified: string[] = [];
    const sub = await t.client.listen(AGENT_SESSION_EVENTS_CHANNEL, (p) => notified.push(p));
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("set_design", grant.secret, { markdown: "# Design" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const item = await itemOf(itemId);
    expect([item.document, item.originContent]).toEqual(["# Design", "originale"]);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev).toMatchObject({ field: "document", agentSessionId });
    const [row] = await t.db.select().from(backlogRefineSessions).where(eq(backlogRefineSessions.itemId, itemId));
    expect(Date.now() - row!.lastActivityAt.getTime()).toBeLessThan(60_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(notified.map((p) => JSON.parse(p).sessionId)).toContain(agentSessionId);
    await sub.unlisten();
  });

  it("segreto assente, sbagliato, revocato o della sessione revocata: 401 e niente scritto", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    expect((await call("set_plan", null, { markdown: "p" })).status).toBe(401);
    expect((await call("set_plan", grant.secret + "x", { markdown: "p" })).status).toBe(401);
    grant.revoke();
    expect((await call("set_plan", grant.secret, { markdown: "p" })).status).toBe(401);
    const other = bridge.grant({ agentSessionId, itemId });
    bridge.revokeSession(agentSessionId);
    expect((await call("set_plan", other.secret, { markdown: "p" })).status).toBe(401);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });

  it("sessione chiusa: 409 session_closed, niente scritto", async () => {
    const { itemId, agentSessionId } = await seeded("closed");
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("set_plan", grant.secret, { markdown: "p" });
    expect([res.status, (await res.json()).error]).toEqual([409, "session_closed"]);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });

  it.each(["converted", "archived"] as const)("voce %s: 409 item_closed, niente scritto", async (status) => {
    const { itemId, agentSessionId } = await seeded();
    await t.db.update(backlogItems).set({ status }).where(eq(backlogItems.id, itemId));
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("update_item", grant.secret, { title: "Nuovo" });
    expect([res.status, (await res.json()).error]).toEqual([409, "item_closed"]);
    expect((await itemOf(itemId)).title).toBe("Voce di test");
  });

  it("conversione in corso (voce in lock, non committata): il ponte ASPETTA e dopo il commit dà 409 item_closed", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // Come la conversione del server: prende la voce, poi chiude la sessione.
    const conversion = t.db.transaction(async (tx) => {
      await tx.update(backlogItems).set({ status: "converted" }).where(eq(backlogItems.id, itemId));
      locked();
      await gate;
      await tx.update(backlogRefineSessions)
        .set({ status: "closed", closedAt: new Date(), closedReason: "item_closed" })
        .where(eq(backlogRefineSessions.agentSessionId, agentSessionId));
    });
    await isLocked;
    let settled = false;
    const pending = call("set_plan", grant.secret, { markdown: "p" }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // in attesa sul lock della voce
    release();
    await conversion;
    const res = await pending;
    expect([res.status, (await res.json()).error]).toEqual([409, "item_closed"]);
    expect((await itemOf(itemId)).implementationPlan).toBeNull();
  });

  it("input non valido: 400 col dettaglio per l'agente; JSON rotto: 400; troppo grande: 413", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    const bad = await call("update_item", grant.secret, { effort: 9 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).message).toMatch(/effort/);
    expect((await call("set_design", grant.secret, "{rotto")).status).toBe(400);
    expect((await call("set_design", grant.secret, { markdown: "x".repeat(1_000_000) })).status).toBe(413);
  });

  it("update_item: scrive i metadati e la revisione coi valori precedenti", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    const res = await call("update_item", grant.secret, { effort: 2, risk: "low", riskNote: "poco" });
    expect(res.status).toBe(200);
    const item = await itemOf(itemId);
    expect([item.effort, item.risk, item.riskNote]).toEqual([2, "low", "poco"]);
    const [rev] = await t.db.select().from(backlogItemRevisions).where(eq(backlogItemRevisions.itemId, itemId));
    expect(rev).toMatchObject({ field: "metadata", previous: { effort: null, risk: null, riskNote: null } });
  });

  it("tool sconosciuto: 404", async () => {
    const { itemId, agentSessionId } = await seeded();
    const grant = bridge.grant({ agentSessionId, itemId });
    expect((await call("delete_item", grant.secret, {})).status).toBe(404);
  });
});

describe("buildRefineMcpConfig", () => {
  it("null se l'entry non esiste (sviluppo con tsx): nessun server MCP fantasma", () => {
    const grant = bridge.grant({ agentSessionId: "a", itemId: "b" });
    expect(buildRefineMcpConfig(bridge, grant, "/nope/index.js")).toBeNull();
  });
  it("l'env del server MCP porta SOLO URL e segreto del ponte", async () => {
    const dir = await mkdtemp(join(tmpdir(), "refine-mcp-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, "");
    const grant = bridge.grant({ agentSessionId: "a", itemId: "b" });
    const cfg = buildRefineMcpConfig(bridge, grant, entry)!;
    const server = cfg.mcpConfig.servers["stubwise_refine"]!;
    expect(Object.keys(server.env!).sort()).toEqual(["REFINE_BRIDGE_SECRET", "REFINE_BRIDGE_URL"]);
    expect(server.env!["REFINE_BRIDGE_SECRET"]).toBe(grant.secret);
    expect(cfg.tools).toEqual(REFINE_TOOL_NAMES);
    await rm(dir, { recursive: true, force: true });
  });
});

/**
 * Il server MCP resta autonomo (niente `@stubwise/shared` nel suo entry, come
 * `ask-user-mcp`), quindi nomi ed enum ce li ha in copia. Questo test è ciò che
 * tiene le copie allineate: legge il server MCP come lo vede il CLI (handshake
 * e `tools/list`) e lo confronta con le fonti di `@stubwise/shared`.
 */
describe("allineamento del server MCP con @stubwise/shared", () => {
  async function inspect() {
    const server = buildRefineMcpServer({ bridgeUrl: "http://127.0.0.1:9", secret: "s" }, fetch);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const name = client.getServerVersion()?.name;
    await client.close();
    return { name, tools };
  }

  it("nome del server e nomi dei tool coincidono con REFINE_MCP_SERVER_NAME e REFINE_TOOLS", async () => {
    const { name, tools } = await inspect();
    expect(name).toBe(REFINE_MCP_SERVER_NAME);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...REFINE_TOOLS].sort());
  });

  it("enum di rischio e urgenza e intervallo dell'effort coincidono con gli schemi di shared", async () => {
    const { tools } = await inspect();
    const props = tools.find((tool) => tool.name === "update_item")!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    /** Le proprietà `.nullable()` arrivano come `anyOf: [<schema>, {type: "null"}]`. */
    const nonNull = (p: Record<string, unknown>): Record<string, unknown> => {
      const anyOf = p["anyOf"] as Record<string, unknown>[] | undefined;
      return anyOf?.find((s) => s["type"] !== "null") ?? p;
    };
    expect(nonNull(props["risk"]!)["enum"]).toEqual(backlogRiskSchema.options);
    expect(nonNull(props["urgency"]!)["enum"]).toEqual(backlogUrgencySchema.options);
    const effort = nonNull(props["effort"]!);
    expect([effort["minimum"], effort["maximum"]]).toEqual([effortSchema.minValue, effortSchema.maxValue]);
  });
});

describe("startRefineBridge, listen fallito", () => {
  it("rigetta invece di restare appeso (index.ts spegne il refinement e il worker parte)", async () => {
    const spy = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) {
      process.nextTick(() => this.emit("error", new Error("EADDRNOTAVAIL")));
      return this;
    });
    try {
      await expect(startRefineBridge({ db: t.db, log: () => undefined })).rejects.toThrow("EADDRNOTAVAIL");
    } finally {
      spy.mockRestore();
    }
  });
});
