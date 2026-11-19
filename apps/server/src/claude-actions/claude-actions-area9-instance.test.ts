import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { aiModelSettings, aiProviders, changeLog, gitAccounts, googleWorkspaces, instanceSettings, issueChatToolToken, outgoingWebhooks } from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { buildApp } from "../app.js";
import { seedUsers } from "../test/fixtures.js";

/**
 * Area 9, F7, Task 4: le B dell'istanza, senza segreti (M-4 = a). Ogni voce
 * chiama la funzione della rotta; un segreto negli argomenti è rifiutato già
 * alla proposta (lo schema `strict`), mai una riconferma parziale; «Annulla»
 * riporta `was` e rifiuta dopo un salvataggio a mano della stessa
 * impostazione (M-7 = a).
 */
let t: TestDb;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminCookie: string;
let memberId: string;
let memberCookie: string;
let n = 0;

beforeAll(async () => {
  t = await startTestDb();
  app = buildApp({ db: t.db, sessionSecret: "x".repeat(40), encryptionKey: randomBytes(32).toString("base64"), publicUrl: "https://stubwise.example" });
  ({ adminId, adminCookie, memberId, memberCookie } = await seedUsers(app));
}, 120_000);

afterAll(async () => {
  await app.close();
  await t.stop();
});

async function propose(actions: unknown[], as: { id: string; cookie: string } = { id: adminId, cookie: adminCookie }) {
  const res = await app.inject({ method: "POST", url: "/api/claude/conversations", headers: { cookie: as.cookie }, payload: {} });
  const sid = (res.json() as { id: string }).id;
  const tok = await issueChatToolToken(t.db, { sessionId: sid, userId: as.id, ttlMs: 60_000 });
  return app.inject({ method: "POST", url: `/api/claude/conversations/${sid}/proposals`, headers: { authorization: `Bearer ${tok}` }, payload: { toolUseId: `tu-a9i-${++n}`, actions } });
}
async function run(actions: unknown[]) {
  const res = await propose(actions);
  const body = res.json() as { status: string; proposalId?: string };
  if (body.status !== "awaiting_confirmation") return { res, groupId: null as string | null };
  const done = await app.inject({ method: "POST", url: `/api/claude/proposals/${body.proposalId}/confirm`, headers: { cookie: adminCookie }, payload: {} });
  return { res: done, groupId: (done.json() as { groupId?: string }).groupId ?? null };
}
const undo = (groupId: string) => app.inject({ method: "POST", url: `/api/claude/groups/${groupId}/undo`, headers: { cookie: adminCookie } });
const call = (method: "POST" | "PATCH" | "PUT", url: string, payload: Record<string, unknown>) => app.inject({ method, url, headers: { cookie: adminCookie }, payload });
const entries = (type: string) => t.db.select().from(changeLog).where(eq(changeLog.type, type));
const instance = async () => (await t.db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)))[0]!;

describe("area 9, F7: le B dell'istanza", () => {
  it("setModel: B, il modello con la sua voce; «Annulla» torna al default", async () => {
    const proposed = await propose([{ fn: "setModel", args: { operation: "triage", model: "opus" } }]);
    expect(proposed.json()).toMatchObject({ status: "awaiting_confirmation" });
    const r = await run([{ fn: "setModel", args: { operation: "triage", model: "opus" } }]);
    expect(r.res.statusCode).toBe(200);
    expect((await t.db.select().from(aiModelSettings).where(eq(aiModelSettings.operation, "triage")))[0]?.model).toBe("opus");
    expect((await entries("model.changed")).length).toBeGreaterThan(0);
    expect((await undo(r.groupId!)).statusCode).toBe(200);
    expect(await t.db.select().from(aiModelSettings).where(eq(aiModelSettings.operation, "triage"))).toEqual([]);
  });

  it("saveBudget: tetto e lingua; un salvataggio a mano dopo Claude blocca «Annulla»", async () => {
    const a = await run([{ fn: "saveBudget", args: { monthlyUsd: 120, contentLanguage: "it" } }]);
    expect(await instance()).toMatchObject({ contentLanguage: "it" });
    expect(Number((await instance()).monthlyBudgetUsd)).toBe(120);
    expect((await undo(a.groupId!)).statusCode).toBe(200);
    expect((await instance()).monthlyBudgetUsd).toBeNull();
    const b = await run([{ fn: "saveBudget", args: { monthlyUsd: 50, contentLanguage: "en" } }]);
    expect((await call("PUT", "/api/settings/instance", { monthlyBudgetUsd: 70 })).statusCode).toBe(200);
    expect((await undo(b.groupId!)).statusCode).toBe(409);
    expect(Number((await instance()).monthlyBudgetUsd)).toBe(70);
  });

  it("M-4: un segreto negli argomenti è rifiutato alla proposta (saveStorage, updateWebhook con l'url); senza, saveStorage salva e si annulla", async () => {
    const withSecret = await propose([{ fn: "saveStorage", args: { endpoint: "https://s3.example", region: "eu", bucket: "b", accessKeyId: "AK", secretAccessKey: "x" } }]);
    expect(withSecret.json()).toMatchObject({ status: "refused" });
    const r = await run([{ fn: "saveStorage", args: { endpoint: "https://s3.example", region: "eu", bucket: "b", accessKeyId: "AK" } }]);
    expect(r.res.statusCode).toBe(200);
    expect(await instance()).toMatchObject({ s3Endpoint: "https://s3.example", s3Bucket: "b", s3AccessKey: "AK", s3SecretKeyEncrypted: null });
    expect((await entries("storage.changed")).length).toBe(1);
    expect((await undo(r.groupId!)).statusCode).toBe(200);
    expect(await instance()).toMatchObject({ s3Endpoint: null, s3Bucket: null });
  });

  it("saveAutomation: tutte le regole e la review; «Annulla» riporta quelle di prima", async () => {
    const before = (await app.inject({ method: "GET", url: "/api/settings/automation", headers: { cookie: adminCookie } })).json() as { rules: { type: string; autoFix: boolean }[]; prReview: unknown };
    const next = { rules: before.rules.map((r) => ({ ...r, autoFix: !r.autoFix })), prReview: { enabled: true, maxCostUsd: 3 } };
    const r = await run([{ fn: "saveAutomation", args: next }]);
    expect(r.res.statusCode).toBe(200);
    expect((await entries("automation.changed")).length).toBeGreaterThan(0);
    expect((await undo(r.groupId!)).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/settings/automation", headers: { cookie: adminCookie } })).json();
    expect(after).toEqual(before);
  });

  it("setProviderEnabled e moveProvider: l'ultimo account acceso non si spegne; il riordino si annulla", async () => {
    const mk = async (label: string) => ((await call("POST", "/api/ai-providers", { kind: "api_key", label, secret: "sk-ant-xxxxxxxx" })).json() as { id: string }).id;
    const a = await mk("Primo");
    const b = await mk("Secondo");
    const off = await run([{ fn: "setProviderEnabled", args: { id: a, enabled: false } }]);
    expect((await t.db.select().from(aiProviders).where(eq(aiProviders.id, a)))[0]!.enabled).toBe(false);
    const last = await run([{ fn: "setProviderEnabled", args: { id: b, enabled: false } }]);
    expect(last.res.json()).toMatchObject({ status: "refused" });
    expect((await undo(off.groupId!)).statusCode).toBe(200);
    expect((await t.db.select().from(aiProviders).where(eq(aiProviders.id, a)))[0]!.enabled).toBe(true);
    const order = async () => (await app.inject({ method: "GET", url: "/api/ai-providers", headers: { cookie: adminCookie } })).json() as { id: string }[];
    const was = (await order()).map((p) => p.id);
    const moved = await run([{ fn: "moveProvider", args: { id: b, toIndex: 0 } }]);
    expect((await order())[0]!.id).toBe(b);
    expect((await undo(moved.groupId!)).statusCode).toBe(200);
    expect((await order()).map((p) => p.id)).toEqual(was);
  });

  it("updateGitAccount, updateGoogleApp, updateWebhook: senza credenziali, segreti né url; «Annulla» coi valori di prima", async () => {
    const git = (await call("POST", "/api/git-accounts", { name: "Bot", provider: "github", credentials: { token: "ghp_xxxxxxxxxxxx" } })).json() as { id: string };
    const g = await run([{ fn: "updateGitAccount", args: { id: git.id, name: "Bot nuovo" } }]);
    expect((await t.db.select().from(gitAccounts).where(eq(gitAccounts.id, git.id)))[0]!.name).toBe("Bot nuovo");
    expect((await undo(g.groupId!)).statusCode).toBe(200);
    expect((await t.db.select().from(gitAccounts).where(eq(gitAccounts.id, git.id)))[0]!.name).toBe("Bot");
    const creds = await propose([{ fn: "updateGitAccount", args: { id: git.id, credentials: { token: "ghp_y" } } }]);
    expect(creds.json()).toMatchObject({ status: "refused" });

    const app1 = (await call("POST", "/api/settings/google-workspaces", { name: "Acme", domains: ["acme.com"], clientId: "1.apps.googleusercontent.com", clientSecret: "s" })).json() as { id: string };
    const ga = await run([{ fn: "updateGoogleApp", args: { id: app1.id, name: "Acme Srl" } }]);
    expect((await t.db.select().from(googleWorkspaces).where(eq(googleWorkspaces.id, app1.id)))[0]!.name).toBe("Acme Srl");
    expect((await undo(ga.groupId!)).statusCode).toBe(200);
    expect((await t.db.select().from(googleWorkspaces).where(eq(googleWorkspaces.id, app1.id)))[0]!.name).toBe("Acme");

    const hook = (await call("POST", "/api/settings/webhooks", { name: "Hook", url: "https://hooks.example.com/in", format: "generic", events: ["job.failed"] })).json() as { id: string };
    const withUrl = await propose([{ fn: "updateWebhook", args: { id: hook.id, url: "https://evil.example.com" } }]);
    expect(withUrl.json()).toMatchObject({ status: "refused" });
    const w = await run([{ fn: "updateWebhook", args: { id: hook.id, enabled: false } }]);
    expect((await t.db.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, hook.id)))[0]!.enabled).toBe(false);
    expect((await undo(w.groupId!)).statusCode).toBe(200);
    expect((await t.db.select().from(outgoingWebhooks).where(eq(outgoingWebhooks.id, hook.id)))[0]!).toMatchObject({ enabled: true, url: "https://hooks.example.com/in" });
  });

  it("rerunSmoke e removePlugin: su un plugin che non c'è sono rifiutate; non hanno «Annulla»", async () => {
    const missing = "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01";
    expect((await run([{ fn: "rerunSmoke", args: { id: missing } }])).res.json()).toMatchObject({ status: "refused" });
    expect((await run([{ fn: "removePlugin", args: { id: missing } }])).res.json()).toMatchObject({ status: "refused" });
  });

  it("NEGATIVI: chi non ha il permesso d'istanza non propone nessuna delle voci d'istanza", async () => {
    for (const action of [
      { fn: "setModel", args: { operation: "triage", model: "opus" } },
      { fn: "saveBudget", args: { monthlyUsd: 1, contentLanguage: "en" } },
      { fn: "setProviderEnabled", args: { id: "6f1c2a52-1d7b-4c3e-9a51-0b6a7f2e1a01", enabled: false } },
    ]) {
      const res = await propose([action], { id: memberId, cookie: memberCookie });
      expect(res.json()).toMatchObject({ status: "refused" });
    }
  });
});
