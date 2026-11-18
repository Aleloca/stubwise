import { describe, expect, it, vi } from "vitest";
import { projectPluginsStaleSchema } from "@stubwise/shared";
import { createStubwiseClient } from "../index.js";

/**
 * Area 9, F1, Task 11: i metodi nuovi — url, verbo, corpo — e il parse di
 * ogni risposta nuova SENZA i campi facoltativi (un server più vecchio, un
 * rollback), più `__unknown__` per un `kind` o un motivo ignoti.
 */
const U1 = "40000000-0000-4000-8000-000000000001";
const P1 = "30000000-0000-4000-8000-000000000001";

function clientWith(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async () =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return { client: createStubwiseClient({ baseUrl: "", getAuthHeader: () => null, fetch: fetchImpl }), fetchImpl };
}
const call = (f: ReturnType<typeof clientWith>["fetchImpl"]) => {
  const [url, init] = f.mock.calls.at(-1)!;
  return { url: String(url), method: String(init!.method), body: init!.body, headers: init!.headers as Record<string, string> };
};

describe("area 9 nel client", () => {
  it("me.sessions: senza i facoltativi, e un kind ignoto è __unknown__", async () => {
    const { client, fetchImpl } = clientWith([{ id: "b_x", kind: "watch", createdAt: "2026-11-16T10:00:00.000Z" }]);
    const [row] = await client.me.sessions();
    expect(call(fetchImpl).url).toBe("/api/me/sessions");
    expect(row).toMatchObject({ kind: "__unknown__", userAgent: null, label: null, lastSeenAt: null, current: false });
  });

  it("me.endSession, deleteAvatar, cancelEmailChange: i verbi e i path", async () => {
    const { client, fetchImpl } = clientWith(null, 204);
    await client.me.endSession("b_a/b");
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["DELETE", "/api/me/sessions/b_a%2Fb"]);
    await client.me.deleteAvatar();
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["DELETE", "/api/me/avatar"]);
    await client.me.cancelEmailChange();
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["DELETE", "/api/me/email-change"]);
  });

  it("me.putAvatar: il corpo BINARIO grezzo, come octet-stream, mai JSON", async () => {
    const { client, fetchImpl } = clientWith(null, 204);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await client.me.putAvatar(bytes);
    const c = call(fetchImpl);
    expect([c.method, c.url]).toEqual(["PUT", "/api/me/avatar"]);
    expect(c.headers["content-type"]).toBe("application/octet-stream");
    expect(c.body).toBe(bytes);
  });

  it("me.emailChange / startEmailChange: senza `pending` vale null", async () => {
    const { client, fetchImpl } = clientWith({ available: false });
    expect(await client.me.emailChange()).toEqual({ available: false, pending: null });
    await client.me.startEmailChange("new@acme.com");
    expect([call(fetchImpl).method, call(fetchImpl).body]).toEqual(["POST", JSON.stringify({ newEmail: "new@acme.com" })]);
  });

  it("auth.emailChangeLink legge (GET, nessuna conferma); confirmEmailChange conferma (POST col token nel corpo)", async () => {
    const { client, fetchImpl } = clientWith({ status: "invalid" });
    expect(await client.auth.emailChangeLink("tok")).toEqual({ status: "invalid", newEmail: null });
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["GET", "/api/auth/email-change/tok"]);
    const confirm = clientWith({ email: "n@acme.com" });
    expect(await confirm.client.auth.confirmEmailChange("tok")).toEqual({ email: "n@acme.com" });
    const c = call(confirm.fetchImpl);
    expect([c.method, c.url, c.body]).toEqual(["POST", "/api/auth/email-change/confirm", JSON.stringify({ token: "tok" })]);
  });

  it("users: deactivate (col reassign), reactivate, changeEmail, passwordReset senza `token`", async () => {
    const { client, fetchImpl } = clientWith(null, 204);
    await client.users.deactivate(U1, { t1: U1, t2: null });
    expect([call(fetchImpl).method, call(fetchImpl).url, call(fetchImpl).body]).toEqual(["POST", `/api/users/${U1}/deactivate`, JSON.stringify({ reassign: { t1: U1, t2: null } })]);
    await client.users.reactivate(U1);
    expect(call(fetchImpl).url).toBe(`/api/users/${U1}/reactivate`);
    const email = clientWith({ email: "x@acme.com" });
    await email.client.users.changeEmail(U1, "x@acme.com");
    expect([call(email.fetchImpl).method, call(email.fetchImpl).url]).toEqual(["PATCH", `/api/users/${U1}/email`]);
    const reset = clientWith({ url: "/reset-password/abc", expiresAt: "2026-11-17T10:00:00.000Z" });
    expect((await reset.client.users.passwordReset(U1)).token).toBeNull();
  });

  it("projects.members: senza `permissions` vale []; una fonte ignota è __unknown__", async () => {
    const base = { userId: U1, email: "a@acme.com", avatarUrl: null, roleId: P1, roleName: "Developer", createdAt: "2026-11-16T10:00:00.000Z" };
    const { client, fetchImpl } = clientWith([base, { ...base, permissions: [{ permission: "runs.start", sources: [{ kind: "nuova" }] }] }]);
    const [without, withSources] = await client.projects.members(P1);
    expect(call(fetchImpl).url).toBe(`/api/projects/${P1}/members`);
    expect(without!.permissions).toEqual([]);
    expect(withSources!.permissions[0]!.sources[0]).toMatchObject({ kind: "__unknown__", roleId: null, byUserId: null });
    const put = clientWith({ ...base, permissions: [] });
    await put.client.projects.putMember(P1, U1, { roleId: P1, permissions: ["runs.start"] });
    expect([call(put.fetchImpl).method, call(put.fetchImpl).url]).toEqual(["PUT", `/api/projects/${P1}/members/${U1}`]);
  });

  it("access.whoCan / whatCan: il querystring, `agent` di default, un motivo ignoto è __unknown__", async () => {
    const { client, fetchImpl } = clientWith({ permission: "runs.start", projectId: P1, people: [{ userId: U1, email: "a@acme.com", reasons: [{ kind: "x" }] }] });
    const who = await client.access.whoCan({ permission: "runs.start", projectId: P1 });
    expect(call(fetchImpl).url).toBe(`/api/access/who-can?permission=runs.start&projectId=${P1}`);
    expect(who.agent).toEqual({ actsFor: "confirmer" });
    expect(who.people[0]!.reasons[0]!.kind).toBe("__unknown__");
    const what = clientWith({ userId: U1, instance: [{ permission: "monitor.view" }], projects: [] });
    const res = await what.client.access.whatCan({ userId: U1 });
    expect(call(what.fetchImpl).url).toBe(`/api/access/what-can?userId=${U1}`);
    expect(res.instance[0]!.reasons).toEqual([]);
  });

  it("inbox: restore, moveToNew, unread", async () => {
    const { client, fetchImpl } = clientWith(null, 204);
    await client.inbox.restore("n1");
    expect(call(fetchImpl).url).toBe("/api/inbox/n1/restore");
    await client.inbox.moveToNew("n1");
    expect(call(fetchImpl).url).toBe("/api/inbox/n1/move-to-new");
    await client.inbox.unread("n1");
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["POST", "/api/inbox/n1/unread"]);
  });
});

describe("area 9: la lettura dell'invito e register", () => {
  it("auth.inviteLink: GET col token; uno scaduto senza i campi li ha a null/[]", async () => {
    const { client, fetchImpl } = clientWith({ status: "expired" });
    expect(await client.auth.inviteLink("tok")).toEqual({ status: "expired", email: null, invitedByName: null, projects: [], instanceRoleName: null, expiresAt: null });
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["GET", "/api/auth/invites/tok"]);
  });

  it("auth.register: l'email è facoltativa (vale quella dell'invito)", async () => {
    const { client, fetchImpl } = clientWith({ user: { id: U1, email: "a@acme.com", role: "member" } }, 201);
    await client.auth.register({ token: "tok", password: "una-password-lunga" });
    expect([call(fetchImpl).method, call(fetchImpl).url, call(fetchImpl).body]).toEqual(["POST", "/api/auth/register", JSON.stringify({ token: "tok", password: "una-password-lunga" })]);
  });
});

describe("area 9: le letture calcolate dell'amministrazione", () => {
  it("admin.person: senza i facoltativi i default; un motivo è una stringa qualunque; uno status ignoto è __unknown__", async () => {
    const { client, fetchImpl } = clientWith({
      personId: U1, name: "a", email: "a@acme.com", status: "suspended", isSelf: false, isFullAdmin: false, hasSecondFactor: false,
      actions: { setInstanceRole: null, resetPassword: "self", resetSecondFactor: null, deactivate: "last_full_admin", reactivate: "status", identities: null },
    });
    const p = await client.admin.person(U1);
    expect(call(fetchImpl).url).toBe(`/api/admin/people/${U1}`);
    expect(p.status).toBe("__unknown__");
    expect(p.actions.changeEmail).toBe("forbidden");
    expect(p).toMatchObject({ projects: [], openTasks: [], instanceRoleChoices: [], peer: false, identities: { gitEmails: [], bitbucketUsername: null } });
  });

  it("admin.roles / invites / inviteChoices / revokeInvite: path e default", async () => {
    const roles = clientWith([{ id: U1, name: "R", scope: "project", permissions: [], reach: "anywhere" }]);
    expect((await roles.client.admin.roles())[0]).toMatchObject({ missing: [], deleteBlock: null, holders: [] });
    const inv = clientWith([{ id: "i_x", email: "x@acme.com", createdAt: "2026-11-16T10:00:00.000Z", expiresAt: "2026-11-17T10:00:00.000Z", expired: false }]);
    expect((await inv.client.admin.invites())[0]).toMatchObject({ projects: [], instanceRole: null });
    const ch = clientWith({});
    expect(await ch.client.admin.inviteChoices()).toEqual({ instanceRoles: [], defaultInstanceRoleId: null, projects: [] });
    const del = clientWith(null, 204);
    await del.client.admin.revokeInvite("i_abc");
    expect([call(del.fetchImpl).method, call(del.fetchImpl).url]).toEqual(["DELETE", "/api/admin/invites/i_abc"]);
  });

  it("projects.membersView / previewMember: path, corpo, default", async () => {
    const view = clientWith({ projectId: P1, members: [], canManage: false });
    expect(await view.client.projects.membersView(P1)).toMatchObject({ roleChoices: [], grantable: [], addable: [], addableMissing: {}, fullAdminNote: true });
    expect(call(view.fetchImpl).url).toBe(`/api/projects/${P1}/members/view`);
    const pre = clientWith({});
    expect(await pre.client.projects.previewMember(P1, U1, { roleId: P1, granted: ["x"] })).toMatchObject({ missing: [], block: null, removing: [] });
    expect([call(pre.fetchImpl).method, call(pre.fetchImpl).url, call(pre.fetchImpl).body]).toEqual(["POST", `/api/projects/${P1}/members/${U1}/preview`, JSON.stringify({ roleId: P1, granted: ["x"] })]);
  });
});

describe("area 9, F2: il registro delle modifiche", () => {
  it("changeLog.list / listProject / filters: path, querystring, e una voce di tipo ignoto è __unknown__", async () => {
    const entry = { id: U1, type: "future.unknown_kind", at: "2026-11-18T10:00:00.000Z", actor: { name: "Ada", kind: "user" }, scope: "instance", group: "queue", data: { object: { type: "x", id: "y", label: "Z" } } };
    const { client, fetchImpl } = clientWith({ entries: [entry] });
    const page = await client.changeLog.list({ project: "instance", group: "roles", cursor: "abc" });
    expect(call(fetchImpl).url).toBe("/api/change-log?project=instance&group=roles&cursor=abc");
    expect(page.nextCursor).toBeNull();
    expect(page.entries[0]).toMatchObject({ type: "__unknown__", projectId: null, objectDeleted: false, data: { params: {} } });
    const proj = clientWith({ entries: [] });
    await proj.client.changeLog.listProject(P1, { withinDays: 7 });
    expect(call(proj.fetchImpl).url).toBe(`/api/projects/${P1}/change-log?withinDays=7`);
    const f = clientWith({ everything: false });
    expect(await f.client.changeLog.filters(P1)).toEqual({ everything: false, people: [], projects: [], groups: [] });
    expect(call(f.fetchImpl).url).toBe(`/api/change-log/filters?project=${P1}`);
  });
});

describe("area 9, F5 nel client", () => {
  it("projects.regenerateIngestionKey e repositories.regenerateWebhookSecret: verbo, path, e un mode ignoto è __unknown__", async () => {
    const k = clientWith({ ingestionKey: "k-nuova" });
    expect(await k.client.projects.regenerateIngestionKey(P1)).toEqual({ ingestionKey: "k-nuova" });
    expect([call(k.fetchImpl).method, call(k.fetchImpl).url]).toEqual(["POST", `/api/projects/${P1}/ingestion-key`]);
    const w = clientWith({ mode: "rollback", platformRestored: false });
    expect(await w.client.repositories.regenerateWebhookSecret("web/app")).toEqual({ mode: "rollback", platformRestored: false });
    expect([call(w.fetchImpl).method, call(w.fetchImpl).url]).toEqual(["POST", "/api/repositories/web%2Fapp/webhook-secret"]);
    expect(await clientWith({ mode: "futuro" }).client.repositories.regenerateWebhookSecret("web")).toMatchObject({ mode: "__unknown__" });
  });

  it("projects.plugins senza version (server vecchio) → null; setPlugins manda ifMatch solo se c'è", async () => {
    const plugin = { pluginId: "50000000-0000-4000-8000-000000000001", enabled: true, disabledSkills: [], disabledHooks: [] };
    const old = clientWith({ plugins: [plugin] });
    expect(await old.client.projects.plugins(P1)).toEqual({ plugins: [plugin], version: null, registry: [] });
    expect(call(old.fetchImpl).url).toBe(`/api/projects/${P1}/plugins`);
    const put = clientWith({ plugins: [plugin], version: "v2" });
    await put.client.projects.setPlugins(P1, [plugin], "v1");
    expect(JSON.parse(String(call(put.fetchImpl).body))).toEqual({ plugins: [plugin], ifMatch: "v1" });
    await put.client.projects.setPlugins(P1, [plugin], null);
    expect(JSON.parse(String(call(put.fetchImpl).body))).toEqual({ plugins: [plugin] });
    expect(call(put.fetchImpl).method).toBe("PUT");
  });

  it("il 409 stale porta versione e stato in ApiError.details", async () => {
    const plugin = { pluginId: "50000000-0000-4000-8000-000000000001", enabled: true, disabledSkills: ["x"], disabledHooks: [] };
    const { client } = clientWith({ code: "stale", message: "changed", version: "v3", plugins: [plugin] }, 409);
    const err = (await client.projects.setPlugins(P1, [], "v1").catch((e: unknown) => e)) as { status: number; code: string; details: unknown };
    expect(err).toMatchObject({ status: 409, code: "stale" });
    expect(projectPluginsStaleSchema.parse(err.details)).toEqual({ version: "v3", plugins: [plugin] });
  });

  it("projects.integration: path, e da un server senza createdAt/createdBy/gitWebhooks/permessi valgono null, [] e false", async () => {
    const { client, fetchImpl } = clientWith({ ingestion: { last4: "9f3a", dsnBase: "https://s/p/demo" }, inbound: { url: "https://s/api/inbound/demo/ticket" } });
    expect(await client.projects.integration(P1)).toEqual({
      ingestion: { last4: "9f3a", createdAt: null, createdBy: null, dsnBase: "https://s/p/demo" },
      inbound: { url: "https://s/api/inbound/demo/ticket" },
      gitWebhooks: [],
      canRegenerateKey: false,
      canRegenerateWebhookSecret: false,
    });
    expect([call(fetchImpl).method, call(fetchImpl).url]).toEqual(["GET", `/api/projects/${P1}/integration`]);
  });

  it("projects.plugins: il registro, [] da un server che non lo manda", async () => {
    const { client } = clientWith({ plugins: [], version: "v1" });
    expect((await client.projects.plugins(P1)).registry).toEqual([]);
  });
});

