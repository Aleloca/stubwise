import { randomUUID } from "node:crypto";
import { agentRuns, instanceSettings, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { buildClaudePrompt, type AutomationFlow, type Step } from "@stubwise/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";
import type { ChatLlmInput } from "./chat-llm.js";

/**
 * LA PROVA CON CLAUDE VERO (area 7, F3, S6, D4): solo chi gestisce (403 senza
 * spendere), il budget a ogni passo (409, nessuna chiamata), LO STESSO prompt
 * dell'esecuzione, la forma verificata come il motore (422 `claude_invalid`).
 * E la stima gratuita.
 */

let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
const calls: ChatLlmInput[] = [];
let answer = '{"outcome":"urgente","reason":"È giù"}';
let gate: Promise<void> | null = null;

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({
    db,
    sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!",
    encryptionKey: Buffer.alloc(32, 7).toString("base64"),
    chatLlm: {
      async *stream(input) {
        calls.push(input);
        if (gate) await gate;
        yield answer;
      },
    },
  });
  await seedUsers(app);
}, 120_000);
afterAll(async () => {
  await app.close();
  await testDb.stop();
});
beforeEach(async () => {
  calls.length = 0;
  answer = '{"outcome":"urgente","reason":"È giù"}';
  await db.delete(instanceSettings);
  await db.delete(agentRuns);
});

async function setup() {
  const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const [p] = await db.insert(projects).values({ name: `P ${code}`, code, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  const lead = await createUserWithSession(app, `l-${randomUUID().slice(0, 8)}@acme.com`);
  const dev = await createUserWithSession(app, `d-${randomUUID().slice(0, 8)}@acme.com`);
  await addMember(app, p!.id, lead.id, "project_lead");
  await addMember(app, p!.id, dev.id, "developer");
  return { p: p!, lead, dev };
}
const call = (headers: { cookie: string }, url: string, payload: object) => app.inject({ method: "POST", url: `/api${url}`, headers, payload });

const claude: Step = { id: "c", kind: "claude", instruction: "Classifica.", inputs: ["avvio.testo"], outcomes: ["urgente", "normale"], fields: [], branches: {} };
async function created(lead: { headers: { cookie: string } }, projectId: string, steps: Step[]) {
  const flow: AutomationFlow = { trigger: { kind: "manual" }, steps, titleTemplate: "t" };
  const res = await app.inject({ method: "POST", url: "/api/automations", headers: lead.headers, payload: { name: "Con Claude", projectId, flow } });
  return res.json() as { id: string; code: string };
}

describe("POST …/test/claude", () => {
  it("chi gestisce: LO STESSO prompt dell'esecuzione, il tag `automation_step` con l'automazione; il risultato verificato torna", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    const res = await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: { avvio: { testo: "Il server è giù" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "urgente", reason: "È giù" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toBe(buildClaudePrompt(claude as Extract<Step, { kind: "claude" }>, { "avvio.testo": "Il server è giù" }).prompt);
    expect(calls[0]!.usage).toMatchObject({ operation: "automation_step", projectId: p.id, automationId: a.id });
  });

  it("chi non gestisce → 403, e NESSUNA chiamata al modello", async () => {
    const { p, lead, dev } = await setup();
    const a = await created(lead, p.id, [claude]);
    expect((await call(dev.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} })).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it("budget mensile esaurito → 409 `budget`, nessuna chiamata", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    await db.insert(instanceSettings).values({ id: 1, monthlyBudgetUsd: "1" });
    await db.insert(agentRuns).values({ operation: "chat", projectId: null, model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: "2" });
    const res = await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "budget" });
    expect(calls).toEqual([]);
  });

  it("un risultato fuori forma (uscita fuori elenco, o non JSON) → 422 `claude_invalid` col risultato rifiutato", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    answer = '{"outcome":"apocalisse","reason":"x"}';
    const bad = await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "claude_invalid", result: { outcome: "apocalisse" }, error: "unknown_outcome" });
    answer = "non lo so";
    expect((await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} })).json()).toMatchObject({ code: "claude_invalid", result: { raw: "non lo so" } });
  });

  it("un percorso che non è un passo di Claude → 400", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    expect((await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "5", vars: {} })).statusCode).toBe(400);
  });
});

describe("POST …/test/estimate (gratuita)", () => {
  it("conta i passi di Claude raggiungibili, coi giri di un «per ogni» dell'esempio; dice il modello; non chiama nessuno", async () => {
    const { p, lead, dev } = await setup();
    const loop: Step = { id: "f", kind: "forEach", list: "avvio.voci", as: "voce", steps: [{ ...claude, id: "c2", inputs: ["voce"] }] };
    const a = await created(lead, p.id, [claude, loop]);
    const res = await call(lead.headers, `/automations/${a.code}/test/estimate`, { version: "draft", event: { avvio: { testo: "x", voci: ["a", "b", "c"] } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { claudeSteps: number; estimateUsd: number | null; model: string };
    expect(body.claudeSteps).toBe(4);
    expect(body.estimateUsd).toBeGreaterThan(0);
    expect(body.model).toContain("sonnet");
    expect(calls).toEqual([]);
    expect((await call(dev.headers, `/automations/${a.code}/test/estimate`, { version: "draft", event: {} })).statusCode).toBe(403);
  });
});

describe("review renderer F3", () => {
  it("un «per ogni» su un elenco che l'esempio non ha (deciso da Claude) conta il MASSIMO dei giri, e la stima lo dice (`upperBound`)", async () => {
    const { p, lead } = await setup();
    const picker: Step = { ...claude, id: "pick", outcomes: [], fields: [{ key: "voci", label: "Voci", type: "list" }] };
    const loop: Step = { id: "f", kind: "forEach", list: "voci", as: "voce", steps: [{ ...claude, id: "c2", inputs: ["voce"] }] };
    const a = await created(lead, p.id, [picker, loop]);
    const body = (await call(lead.headers, `/automations/${a.code}/test/estimate`, { version: "draft", event: { avvio: { testo: "x" } } })).json() as { claudeSteps: number; upperBound: boolean };
    expect(body).toMatchObject({ claudeSteps: 51, upperBound: true });
    const known = await created(lead, p.id, [claude]);
    expect((await call(lead.headers, `/automations/${known.code}/test/estimate`, { version: "draft", event: { avvio: { testo: "c'è" } } })).json()).toMatchObject({ claudeSteps: 1, upperBound: false });
  });

  it("`rev` della bozza: se è cambiata → 409 `stale` col rev attuale, e nessuna chiamata", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    const stale = await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", rev: 99, path: "0", vars: {} });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale", rev: 1 });
    expect(calls).toEqual([]);
    expect((await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", rev: 1, path: "0", vars: {} })).statusCode).toBe(200);
  });
});

describe("review F3, M8: la stima non conta come vuoto un input che l'esempio non ha", () => {
  it("un passo di Claude che legge un campo ricavato prima costa come un input pieno, e la stima è un tetto", async () => {
    const { p, lead } = await setup();
    const first: Step = { ...claude, id: "uno", outcomes: [], fields: [{ key: "sintesi", label: "Sintesi", type: "text" }] };
    const second: Step = { ...claude, id: "due", inputs: ["sintesi"] };
    const a = await created(lead, p.id, [first, second]);
    const onlyFirst = await created(lead, p.id, [first]);
    const both = (await call(lead.headers, `/automations/${a.code}/test/estimate`, { version: "draft", event: { avvio: { testo: "breve" } } })).json() as { estimateUsd: number; upperBound: boolean };
    const one = (await call(lead.headers, `/automations/${onlyFirst.code}/test/estimate`, { version: "draft", event: { avvio: { testo: "breve" } } })).json() as { estimateUsd: number };
    expect(both.upperBound).toBe(true);
    // Il secondo passo, con l'input ricavato contato pieno, costa più del primo da solo.
    expect(both.estimateUsd - one.estimateUsd).toBeGreaterThan(one.estimateUsd);
  });
});

describe("review F3, M9: una prova alla volta per automazione", () => {
  it("due passi di Claude della prova insieme: uno parte, l'altro 409 `test_busy` senza chiamare il modello", async () => {
    const { p, lead } = await setup();
    const a = await created(lead, p.id, [claude]);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    const first = call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} });
    await new Promise((r) => setTimeout(r, 100));
    const second = await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "test_busy" });
    open();
    gate = null;
    expect((await first).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // Finita la prima, la prossima passa.
    expect((await call(lead.headers, `/automations/${a.code}/test/claude`, { version: "draft", path: "0", vars: {} })).statusCode).toBe(200);
  });
});

