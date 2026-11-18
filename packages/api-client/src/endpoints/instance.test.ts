import { describe, expect, it, vi } from "vitest";
import { createStubwiseClient } from "../index.js";

/**
 * Area 9, F3, Task 8b: le pagine d'istanza della 9b nel client — url, verbo,
 * corpo — e il parse SENZA i facoltativi (un server più vecchio, un rollback).
 * Nessuna risposta porta un segreto: lo schema non ne ha il campo.
 */
const ID = "60000000-0000-4000-8000-000000000001";

function clientWith(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const last = (f: ReturnType<typeof clientWith>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url: String(url), method: String(init!.method), body: init!.body ? JSON.parse(String(init!.body)) : undefined };
};

const provider = { id: ID, kind: "api_key", label: "Primo", position: 0, enabled: true, secretSet: true, createdAt: "2026-11-18T10:00:00.000Z", testStatus: "idle" };
const account = { id: ID, name: "Bot", provider: "github", workspace: null, createdAt: "2026-11-18T10:00:00.000Z" };
const plugin = { id: ID, slug: "log", name: "log", sourceUrl: "https://github.com/acme/log", sourceSubdir: null, ref: "v1", resolvedSha: null, status: "none", inventory: null, error: null, smokeStatus: "idle", smokeError: null, pendingJobKind: null, materializedAt: null, createdAt: "2026-11-18T10:00:00.000Z", updatedAt: "2026-11-18T10:00:00.000Z" };

describe("aiProviders", () => {
  it("list senza gli esiti della prova; create, update (rinomina), reorder, test, remove", async () => {
    const { client, fetchImpl } = clientWith([provider]);
    // Senza i campi dell'8c (un server di prima): né ultimo acceso, né cifre, né limite.
    expect((await client.aiProviders.list())[0]).toMatchObject({ testRequestedAt: null, testCheckedAt: null, testError: null, lastEnabled: false, last4: null, limitedUntil: null, quotaBand: "ok" });
    await client.aiProviders.reorder([ID]);
    expect(last(fetchImpl)).toEqual({ method: "POST", url: "/api/ai-providers/reorder", body: { orderedIds: [ID] } });
    const one = clientWith(provider);
    await one.client.aiProviders.create({ kind: "api_key", label: "Primo", secret: "sk" });
    expect(last(one.fetchImpl)).toMatchObject({ method: "POST", url: "/api/ai-providers" });
    await one.client.aiProviders.update(ID, { label: "Nuovo" });
    expect(last(one.fetchImpl)).toEqual({ method: "PATCH", url: `/api/ai-providers/${ID}`, body: { label: "Nuovo" } });
    await one.client.aiProviders.test(ID);
    expect(last(one.fetchImpl)).toMatchObject({ method: "POST", url: `/api/ai-providers/${ID}/test` });
    const gone = clientWith(null, 204);
    await gone.client.aiProviders.remove(ID);
    expect(last(gone.fetchImpl)).toMatchObject({ method: "DELETE", url: `/api/ai-providers/${ID}` });
  });
});

describe("gitAccounts", () => {
  it("list senza isDefaultReviewer; setDefaultReviewer senza replaced/warnings; validate, update, remove", async () => {
    const { client } = clientWith([account]);
    expect((await client.gitAccounts.list())[0]).toMatchObject({ isDefaultReviewer: false });
    const def = clientWith({ account });
    expect(await def.client.gitAccounts.setDefaultReviewer(ID)).toMatchObject({ replaced: null, warnings: [] });
    expect(last(def.fetchImpl)).toMatchObject({ method: "PUT", url: `/api/git-accounts/${ID}/default-reviewer` });
    const val = clientWith({ ok: true, checks: [] });
    await val.client.gitAccounts.validate(ID);
    expect(last(val.fetchImpl)).toMatchObject({ method: "POST", url: `/api/git-accounts/${ID}/validate` });
    const upd = clientWith(account);
    await upd.client.gitAccounts.update(ID, { credentials: { token: "t" } });
    expect(last(upd.fetchImpl)).toEqual({ method: "PATCH", url: `/api/git-accounts/${ID}`, body: { credentials: { token: "t" } } });
    const gone = clientWith(null, 204);
    await gone.client.gitAccounts.unsetDefaultReviewer(ID);
    expect(last(gone.fetchImpl)).toMatchObject({ method: "DELETE", url: `/api/git-accounts/${ID}/default-reviewer` });
  });
});

describe("plugins", () => {
  it("list senza recommendations; register e updateRef con trust; rerunSmoke, remove", async () => {
    const { client } = clientWith({ plugins: [plugin] });
    expect(await client.plugins.list()).toMatchObject({ recommendations: {} });
    const reg = clientWith(plugin, 201);
    await reg.client.plugins.register({ sourceUrl: "https://github.com/acme/log", ref: "v1", trust: true });
    expect(last(reg.fetchImpl)).toEqual({ method: "POST", url: "/api/plugins", body: { sourceUrl: "https://github.com/acme/log", ref: "v1", trust: true } });
    const q = clientWith({ queued: true }, 202);
    await q.client.plugins.updateRef(ID, "v2", true);
    expect(last(q.fetchImpl)).toEqual({ method: "POST", url: `/api/plugins/${ID}/update`, body: { ref: "v2", trust: true } });
    await q.client.plugins.rerunSmoke(ID);
    expect(last(q.fetchImpl)).toMatchObject({ method: "POST", url: `/api/plugins/${ID}/smoke` });
  });
});

describe("googleApps e instanceSettings", () => {
  it("le app Google senza accountCount; l'istanza senza i campi S3 e Slack; save e automazione", async () => {
    const g = clientWith([{ id: ID, name: "Acme", domains: ["acme.com"], clientId: "c", clientSecretSet: true, redirectUri: "https://s/cb", createdAt: "2026-11-18T10:00:00.000Z" }]);
    expect((await g.client.googleApps.list())[0]).toMatchObject({ accountCount: 0 });
    expect(last(g.fetchImpl).url).toBe("/api/settings/google-workspaces");
    const i = clientWith({ contentLanguage: "it", monthlyBudgetUsd: null });
    expect(await i.client.instanceSettings.get()).toMatchObject({ s3Endpoint: null, s3SecretKeySet: false, attachmentsEnabled: false, slackEnabled: false, spentUsd: 0, budgetReached: false, budgetEffect: null });
    await i.client.instanceSettings.save({ contentLanguage: "it", monthlyBudgetUsd: 600, s3Bucket: "b" });
    expect(last(i.fetchImpl)).toEqual({ method: "PUT", url: "/api/settings/instance", body: { contentLanguage: "it", monthlyBudgetUsd: 600, s3Bucket: "b" } });
    // Review F3: il server tratta un budget ASSENTE come «nessun budget» (e lo
    // registra): chi salva deve dirlo, sempre — il tipo lo pretende.
    // @ts-expect-error monthlyBudgetUsd è obbligatorio
    void (() => i.client.instanceSettings.save({ contentLanguage: "it", s3Bucket: "b" }));
    const a = clientWith({ rules: [{ type: "bug", autoFix: true, maxEffort: 2 }], prReview: { enabled: false } });
    expect(await a.client.instanceSettings.automation()).toMatchObject({ rules: [{ planApprovalMinEffort: null, maxCostUsd: null }], prReview: { maxCostUsd: null } });
  });
});

describe("aiUsage", () => {
  it("snapshots: senza i reset e con una finestra assente; una banda ignota da un server nuovo nella vista è __unknown__", async () => {
    const { client, fetchImpl } = clientWith([{ providerId: ID, providerLabel: "Abbonamento", capturedAt: "2026-11-18T10:00:00.000Z", sessionRemaining: { percentUsed: 30, percentRemaining: 70 }, source: "deterministic", parseOk: true }]);
    const [snap] = await client.aiUsage.snapshots();
    expect(last(fetchImpl)).toMatchObject({ method: "GET", url: "/api/ai-usage/snapshots" });
    expect(snap).toMatchObject({ weeklyRemaining: null, sessionResetAt: null, weeklyResetAt: null });
    const v = clientWith([{ ...provider, quotaBand: "molto_vicino" }]);
    expect((await v.client.aiProviders.list())[0]!.quotaBand).toBe("__unknown__");
  });
});
