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
    expect(await i.client.instanceSettings.get()).toMatchObject({ s3Endpoint: null, s3SecretKeySet: false, attachmentsEnabled: false, spentUsd: 0, budgetReached: false, budgetEffect: null });
    await i.client.instanceSettings.save({ contentLanguage: "it", monthlyBudgetUsd: 600, s3Bucket: "b" });
    expect(last(i.fetchImpl)).toEqual({ method: "PUT", url: "/api/settings/instance", body: { contentLanguage: "it", monthlyBudgetUsd: 600, s3Bucket: "b" } });
    // Una PATCH (review F3, critico): il solo storage, senza budget né lingua.
    await i.client.instanceSettings.save({ s3Bucket: "c" });
    expect(last(i.fetchImpl).body).toEqual({ s3Bucket: "c" });
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

describe("instance.status (area 9, F4)", () => {
  it("senza i facoltativi: blocchi, worker, quota, errori e notte ai default; un kind ignoto è __unknown__", async () => {
    const { client, fetchImpl } = clientWith({
      queues: [{ projectId: "p", code: "ACQ", name: "Acquisti", running: 1, waiting: 0, failed: 0 }],
      jobs: [{ id: "j", kind: "lavoro_futuro", projectId: "p", state: "running", since: "2026-11-18T10:00:00.000Z" }],
      refreshedAt: "2026-11-18T10:00:00.000Z",
    });
    const s = await client.instance.status();
    expect(last(fetchImpl)).toMatchObject({ method: "GET", url: "/api/instance/status" });
    expect(s).toMatchObject({ otherProjects: null, workers: [], quota: [], errors: [], nightly: [] });
    expect(s.queues[0]).toMatchObject({ paused: null, pause: "forbidden", budgetAfterResume: 0 });
    expect(s.jobs[0]).toMatchObject({ kind: "__unknown__", waiting: null, workerId: null, retry: "unavailable", retryNeeds: null, retryBlock: null, retryStopsAtPlan: false, href: null, superseded: false });
  });
});

describe("la coda di un progetto (area 9, F4)", () => {
  it("pauseQueue e resumeQueue: verbi e path", async () => {
    const { client, fetchImpl } = clientWith(null, 204);
    await client.projects.pauseQueue("p/1");
    expect(last(fetchImpl)).toMatchObject({ method: "POST", url: "/api/projects/p%2F1/queue/pause" });
    await client.projects.resumeQueue("p");
    expect(last(fetchImpl)).toMatchObject({ method: "POST", url: "/api/projects/p/queue/resume" });
  });
});

describe("archivia e riapri (area 9, F6)", () => {
  it("archivePreview parsa l'anteprima (un kind ignoto è __unknown__, i campi mancanti col default); archive e reopen: verbi e path", async () => {
    const preview = clientWith({ openAutomationRuns: 2, busy: [{ kind: "claude_session", code: "AUD-12", title: "Login" }, { kind: "futuro" }] });
    const p = await preview.client.projects.archivePreview("p/1");
    expect(last(preview.fetchImpl)).toMatchObject({ method: "GET", url: "/api/projects/p%2F1/archive-preview" });
    expect(p.openAutomationRuns).toBe(2);
    expect(p.busy[0]).toEqual({ kind: "claude_session", code: "AUD-12", title: "Login", waiting: false, repository: null, paused: false });
    expect(p.busy[1]!.kind).toBe("__unknown__");
    // Un server che non manda `publicSurfaces` (prima di questo campo): tutte spente.
    expect(p.publicSurfaces).toEqual({ sdk: false, widget: false, inbound: false, gitWebhook: false });
    const { client, fetchImpl } = clientWith(null, 204);
    await client.projects.archive("p");
    expect(last(fetchImpl)).toMatchObject({ method: "POST", url: "/api/projects/p/archive" });
    await client.projects.reopen("p");
    expect(last(fetchImpl)).toMatchObject({ method: "POST", url: "/api/projects/p/reopen" });
  });

  it("deletionPreview parsa l'anteprima; delete manda il codice nel corpo", async () => {
    const preview = clientWith({ counts: { tasks: 3 } });
    const d = await preview.client.projects.deletionPreview("p/1");
    expect(last(preview.fetchImpl)).toMatchObject({ method: "GET", url: "/api/projects/p%2F1/deletion-preview" });
    expect(d).toMatchObject({ orphanServers: [], detachedRepositories: [], counts: { tasks: 3, releases: 0 } });
    const { client, fetchImpl } = clientWith(null, 204);
    await client.projects.delete("p", "AUD");
    expect(last(fetchImpl)).toMatchObject({ method: "DELETE", url: "/api/projects/p" });
    expect(last(fetchImpl).body).toEqual({ confirmCode: "AUD" });
  });

  it("archived e archivedView: path e default (un server che non manda i campi facoltativi)", async () => {
    const row = { projectId: "50000000-0000-4000-8000-000000000001", code: "AUD", name: "Audin", archivedAt: "2026-11-19T10:00:00.000Z" };
    const list = clientWith([row]);
    expect(await list.client.projects.archived()).toEqual([{ ...row, clientName: null, archivedBy: null, canReopen: false, canDelete: false }]);
    expect(last(list.fetchImpl)).toMatchObject({ method: "GET", url: "/api/projects/archived" });
    const view = clientWith({ ...row, counts: {}, switchesOnReopen: {}, pulseEveryDays: 7 });
    const v = await view.client.projects.archivedView("p/1");
    expect(last(view.fetchImpl)).toMatchObject({ method: "GET", url: "/api/projects/p%2F1/archived-view" });
    expect(v).toMatchObject({ description: "", members: [], repositories: [], pulseEveryDays: 7 });
    expect(v.counts).toEqual({ tasks: 0, requests: 0, docPages: 0, conversations: 0, channels: 0, driveFiles: 0, automations: 0, environments: 0, envFiles: 0, releases: 0 });
    expect(v.switchesOnReopen).toEqual({ docsNightly: false, dailyReport: false, backlogDiscovery: false, pulse: false, weeklyBrief: false });
  });
});

describe("usage.summary (area 9, F4)", () => {
  it("i tre intervalli diventano i parametri; senza i facoltativi: cache 0, figli vuoti, codice null", async () => {
    const { client, fetchImpl } = clientWith({ totals: { costUsd: 1, inputTokens: 2, outputTokens: 3, runs: 1 }, byDay: [], rows: [{ key: "other", label: "other", costUsd: 1, tokens: 5, runs: 1 }] });
    const s = await client.usage.summary({ range: { days: 30 }, groupBy: "project", thenBy: "model" });
    expect(last(fetchImpl).url).toBe("/api/ai-usage/summary?days=30&groupBy=project&thenBy=model");
    expect(s.totals.cacheReadTokens).toBe(0);
    expect(s.rows[0]).toMatchObject({ code: null, children: [] });
    await client.usage.summary({ range: { month: true }, groupBy: "day" });
    expect(last(fetchImpl).url).toBe("/api/ai-usage/summary?month=1&groupBy=day");
    await client.usage.summary({ range: { from: "2026-11-01", to: "2026-11-10" }, groupBy: "operation" });
    expect(last(fetchImpl).url).toBe("/api/ai-usage/summary?from=2026-11-01&to=2026-11-10&groupBy=operation");
  });
});

describe("instance.retryJob (area 9, F4)", () => {
  it("verbo e path; senza stopsAtPlan vale false", async () => {
    const { client, fetchImpl } = clientWith({ jobId: "j2", status: "queued" }, 202);
    expect(await client.instance.retryJob("j/1")).toEqual({ jobId: "j2", status: "queued", stopsAtPlan: false });
    expect(last(fetchImpl)).toMatchObject({ method: "POST", url: "/api/instance/jobs/j%2F1/retry" });
  });
});

describe("queuePause nella vista di progetto (area 9, F4, J-6)", () => {
  it("senza il campo (un server di prima) vale null", async () => {
    const { client } = clientWith({ id: "40000000-0000-4000-8000-000000000001", name: "Acquisti", slug: "acquisti", description: null, aiProviderId: null, aiProviderExclusive: false, docAutoUpdate: false, dailyReportEnabled: false, backlogEnabled: false, pulseEnabled: false, pulseEveryDays: 7, weeklyBriefEnabled: false, prCorrectionMaxRounds: 0, ingestionKey: "k", nextTicketNumber: 1, createdAt: "2026-11-18T10:00:00.000Z", code: "ACQ" });
    const p = await client.request("GET", "/api/projects/x", undefined, (await import("@stubwise/shared")).projectSchema);
    expect(p.queuePause).toBeNull();
  });
});

describe("aiBlockSchema aperto (area 9, F4)", () => {
  it("un motivo d'attesa ignoto (un server più nuovo) è __unknown__, non fa fallire la vista; il budget senza i campi della pausa", async () => {
    const { client } = clientWith({
      queues: [],
      jobs: [
        { id: "a", kind: "task_run", projectId: "p", state: "waiting", since: "2026-11-18T10:00:00.000Z", waiting: { reason: "motivo_futuro" } },
        { id: "b", kind: "automation", projectId: "p", state: "waiting", since: "2026-11-18T10:00:00.000Z", waiting: { reason: "monthly_budget" } },
      ],
      refreshedAt: "2026-11-18T10:00:00.000Z",
    });
    const s = await client.instance.status();
    expect(s.jobs[0]!.waiting).toMatchObject({ reason: "__unknown__" });
    expect(s.jobs[1]!.waiting).toEqual({ reason: "monthly_budget", byId: null, byName: "", since: null });
  });
});

