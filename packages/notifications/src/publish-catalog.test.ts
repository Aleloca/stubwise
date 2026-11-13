import { alertSubscriptions, deviceTokens, notificationDeliveries, notifications, projectMembers, roles, users, type Db } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotificationEvent } from "./format.js";
import { catalogPermissionVisible } from "./inbox-visibility.js";
import { userIdsWithPermission } from "./project-access.js";
import { alertTypeOf } from "@stubwise/shared";
import { publishNotification } from "./publish.js";

/**
 * Area 8, F2, S2–S3: gli avvisi del catalogo alla pubblicazione, su un
 * Postgres vero. Destinatari dal catalogo (default, iscrizioni, obbligatori),
 * mai Slack né webhook (M3), il push dal Telefono del tipo (M-2 = b), e S-4:
 * chi non ha toccato niente riceve quello che riceveva.
 */

let testDb: TestDb;
let db: Db;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
}, 120_000);
afterAll(async () => {
  await testDb?.stop();
});
beforeEach(async () => {
  await db.delete(users);
  await db.delete(notificationDeliveries);
});

async function person(opts: { role?: "admin" | "member"; notifyPush?: boolean; slack?: boolean; device?: boolean } = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: "x",
      role: opts.role ?? "member",
      notifyPush: opts.notifyPush ?? true,
      slackUserId: opts.slack ? `U${randomUUID().slice(0, 8)}` : null,
      notifySlackDm: true,
    })
    .returning();
  if (opts.device) await db.insert(deviceTokens).values({ userId: u!.id, platform: "ios", token: `tok-${randomUUID()}` });
  return u!.id;
}
async function join(userId: string, projectId: string, preset: string) {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, preset));
  await db.insert(projectMembers).values({ userId, projectId, roleId: role!.id });
}
const failed = (projectId: string): NotificationEvent => ({
  kind: "release.failed",
  projectId,
  releaseId: randomUUID(),
  releaseCode: "ACQ-V1",
  title: "Checkout",
  failedRun: "test",
  url: "https://s.example/app/#/p/ACQ/releases/ACQ-V1",
});
const monitor = (): NotificationEvent => ({ kind: "monitor.alert", serverName: "web-1", condition: "disk", detail: "disco al 95%", url: "https://s.example/monitor/servers/x" });
const cardsOf = async (kind: string) => (await db.select({ userId: notifications.userId }).from(notifications).where(eq(notifications.kind, kind as never))).map((r) => r.userId).sort();
const deliveriesOf = async (channel: "push" | "slack_dm" | "webhook") =>
  db.select({ id: notificationDeliveries.id, notificationId: notificationDeliveries.notificationId }).from(notificationDeliveries).where(eq(notificationDeliveries.channel, channel));

async function scenario() {
  const { projectId } = await seedRepository(db);
  const admin = await person({ role: "admin", slack: true, device: true });
  const lead = await person({ slack: true, device: true });
  const dev = await person({ device: true });
  const viewer = await person({ device: true });
  await join(lead, projectId, "project_lead");
  await join(dev, projectId, "developer");
  await join(viewer, projectId, "viewer");
  return { projectId, admin, lead, dev, viewer };
}

describe("avvisi del catalogo alla pubblicazione (area 8, F2)", () => {
  it("S-4, due momenti: release.failed va a chi lo riceveva col routing della F1 (release.merge nel progetto)", async () => {
    const s = await scenario();
    const before = (await userIdsWithPermission(db, "release.merge", s.projectId)).sort();
    await publishNotification(db, failed(s.projectId), { projectId: s.projectId });
    expect(await cardsOf("release.failed")).toEqual(before);
  });

  it("M-1 = a: un monitor.* con progetto va a chi ha monitor.manage; senza progetto resta sul routing di oggi", async () => {
    const s = await scenario();
    // `monitor.manage` è un permesso d'ISTANZA: oggi lo hanno i full admin e chi
    // ha un ruolo d'istanza che lo porta. Due momenti: gli stessi.
    const before = (await userIdsWithPermission(db, "monitor.manage", s.projectId)).sort();
    await publishNotification(db, monitor(), { projectId: s.projectId });
    expect(await cardsOf("monitor.alert")).toEqual(before);
    expect(before).toEqual([s.admin]);
    await db.delete(notifications);
    await publishNotification(db, monitor(), {});
    // Oggi, senza progetto: i deciders d'istanza (monitor.manage), cioè i full admin.
    expect(await cardsOf("monitor.alert")).toEqual([s.admin]);
  });

  it("M3: un avviso del catalogo non va mai su Slack (DM) né sul webhook; senza progetto il monitor ci va come oggi", async () => {
    const s = await scenario();
    await publishNotification(db, failed(s.projectId), { projectId: s.projectId });
    expect(await deliveriesOf("slack_dm")).toEqual([]);
    await publishNotification(db, monitor(), {});
    expect((await deliveriesOf("slack_dm")).length).toBeGreaterThan(0);
  });

  it("M-2 = b: il push segue il Telefono del tipo, non `notify_push` della persona", async () => {
    const { projectId } = await seedRepository(db);
    const off = await person({ notifyPush: false, device: true }); // push spento, Telefono acceso
    const on = await person({ notifyPush: true, device: true }); // push acceso, Telefono spento
    await join(off, projectId, "project_lead");
    await join(on, projectId, "project_lead");
    await db.insert(alertSubscriptions).values([
      { userId: off, projectId, alertType: "release.failed", app: true, phone: true },
      { userId: on, projectId, alertType: "release.failed", app: true, phone: false },
    ]);
    await publishNotification(db, failed(projectId), { projectId });
    const pushed = await deliveriesOf("push");
    const owners = pushed.length
      ? (await db.select({ userId: notifications.userId }).from(notifications).where(inArray(notifications.id, pushed.map((d) => d.notificationId!)))).map((r) => r.userId)
      : [];
    expect(owners).toEqual([off]);
  });

  it("46: il giorno del deploy chi ha `push` spento e nessuna riga NON riceve un telefono nuovo per release.failed", async () => {
    const { projectId } = await seedRepository(db);
    const quiet = await person({ notifyPush: false, device: true });
    const loud = await person({ notifyPush: true, device: true });
    await join(quiet, projectId, "project_lead");
    await join(loud, projectId, "project_lead");
    await publishNotification(db, failed(projectId), { projectId });
    const pushed = await deliveriesOf("push");
    const owners = (await db.select({ userId: notifications.userId }).from(notifications).where(inArray(notifications.id, pushed.map((d) => d.notificationId!)))).map((r) => r.userId);
    expect(owners).toEqual([loud]);
    expect(await cardsOf("release.failed")).toEqual([quiet, loud].sort());
  });

  it("spegnere vale per il futuro; un obbligatorio arriva anche spento", async () => {
    const s = await scenario();
    await publishNotification(db, failed(s.projectId), { projectId: s.projectId });
    await db.insert(alertSubscriptions).values({ userId: s.lead, projectId: s.projectId, alertType: "release.failed", app: false, phone: false });
    await publishNotification(db, failed(s.projectId), { projectId: s.projectId });
    // La prima card del lead resta; la seconda non arriva.
    expect((await cardsOf("release.failed")).filter((u) => u === s.lead)).toHaveLength(1);
    await publishNotification(db, failed(s.projectId), { projectId: s.projectId, mandatory: [{ userId: s.lead, reason: "merged" }] });
    expect((await cardsOf("release.failed")).filter((u) => u === s.lead)).toHaveLength(2);
    // Il motivo sta sulla card di CHI la riceve da obbligatorio, e solo lì.
    const last = await db.select({ userId: notifications.userId, event: notifications.event }).from(notifications).where(eq(notifications.kind, "release.failed"));
    const leadCards = last.filter((n) => n.userId === s.lead).map((n) => (n.event as { alertMandatory?: string }).alertMandatory);
    expect(leadCards).toContain("merged");
    expect(last.filter((n) => n.userId === s.admin).every((n) => (n.event as { alertMandatory?: string }).alertMandatory === undefined)).toBe(true);
  });

  it("un tipo non ancora vivo (non in LIVE_ALERT_TYPES) resta sul routing di oggi", async () => {
    const s = await scenario();
    await db.insert(alertSubscriptions).values({ userId: s.viewer, projectId: s.projectId, alertType: "release.merged", app: true, phone: false });
    await publishNotification(db, { kind: "release.merged", projectId: s.projectId, releaseId: randomUUID(), releaseCode: "ACQ-V2", title: "x", url: "u" }, { projectId: s.projectId });
    expect(await cardsOf("release.merged")).not.toContain(s.viewer);
  });

  it("la revoca a lettura: chi perde `subscribe.perm` (repos.view) non vede la card, la rivede se torna; chi l'ha avuta da obbligatorio la vede", async () => {
    const { projectId } = await seedRepository(db);
    const subscriber = await person();
    const author = await person();
    await join(subscriber, projectId, "developer");
    await join(author, projectId, "contributor");
    const event = { kind: "pr.analysis_issues", projectId, repositoryName: "web", prNumber: 4, prUrl: "u", title: "t", url: "u" };
    await db.insert(notifications).values([
      { userId: subscriber, projectId, kind: "pr.analysis_issues", event, status: "open" },
      { userId: author, projectId, kind: "pr.analysis_issues", event: { ...event, alertMandatory: "pr_author" }, status: "open" },
    ]);
    const clause = catalogPermissionVisible([alertTypeOf("pr.analysis_issues")!]);
    const visible = async () => (await db.select({ userId: notifications.userId }).from(notifications).where(clause)).map((r) => r.userId).sort();
    expect(await visible()).toEqual([subscriber, author].sort());
    // Il Developer diventa Contributor (niente repos.view): la sua card sparisce; quella dell'autore (obbligatoria) resta.
    const [viewerRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "contributor"));
    const [devRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "developer"));
    await db.update(projectMembers).set({ roleId: viewerRole!.id }).where(eq(projectMembers.userId, subscriber));
    expect(await visible()).toEqual([author]);
    await db.update(projectMembers).set({ roleId: devRole!.id }).where(eq(projectMembers.userId, subscriber));
    expect(await visible()).toEqual([subscriber, author].sort());
  });
});
