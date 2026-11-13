import { randomUUID } from "node:crypto";
import {
  automationEffects,
  automationRunInputs,
  automationRunLog,
  automationRuns,
  automations,
  automationVersions,
  googleAccounts,
  googleWorkspaces,
  mailOutgoing,
  notifications,
  projectMembers,
  projects,
  roles,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { effectKey } from "./effects.js";
import { executeDueRuns } from "./executor.js";

/**
 * L'EMAIL DI UN PASSO (area 7, F2, S3 e S4; piano C-F2-1): l'esecutore scrive
 * l'invio trattenuto della Posta (`mail_outgoing`, senza bozza) con la sua
 * chiave d'idempotenza e aspetta che il mittente lo mandi: `sent` → ok, col
 * messaggio nel registro; `failed` → il passo fallisce col codice, e NESSUNO
 * ritenta da solo. Un'email «chiede a» non parte prima dell'Approva. La
 * casella persa a metà fa fallire il passo e mette l'automazione in pausa.
 */

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
let t: TestDb;
let projectId: string;
let ownerId: string;
let accountId: string;
let ownerEmail: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  await t.db.update(projects).set({ code: `M${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}` }).where(eq(projects.id, projectId));
  ownerId = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member", displayName: "Olga" }).returning())[0]!.id;
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, "project_lead"));
  await t.db.insert(projectMembers).values({ projectId, userId: ownerId, roleId: role!.id });
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "W", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  ownerEmail = `olga-${randomUUID().slice(0, 6)}@acme.com`;
  accountId = (await t.db.insert(googleAccounts).values({ userId: ownerId, workspaceId: ws!.id, email: ownerEmail, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [GMAIL_MODIFY] }).returning())[0]!.id;
});

const auto = { mode: "auto" } as const;
const email = (over: Partial<Extract<Step, { kind: "sendEmail" }>> = {}): Step => ({ id: `e${seq++}`, kind: "sendEmail", to: "cliente@b.it", subject: "Benvenuto {{avvio.data}}", body: "Ciao", attachRefs: [], approval: auto, ...over });

async function runOf(steps: Step[], over: { mailbox?: string | null; parentRunId?: string } = {}) {
  const n = seq++;
  const flow: AutomationFlow = { trigger: { kind: "manual" }, steps, titleTemplate: "Run" };
  const [a] = await t.db
    .insert(automations)
    .values({ code: `M${n}-A${n}`, seq: n, name: `Auto ${n}`, projectId, ownerId, status: "active", activeSince: new Date(), mailboxAccountId: over.mailbox === undefined ? accountId : over.mailbox })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(), publishedBy: ownerId });
  const [run] = await t.db
    .insert(automationRuns)
    .values({ automationId: a!.id, n: 1, version: 1, title: "Run", origin: "manual", event: { avvio: { data: "2026-11-13" } }, projectIds: [projectId], ...(over.parentRunId ? { parentRunId: over.parentRunId } : {}) })
    .returning();
  return { automation: a!, run: run! };
}

const exec = () => executeDueRuns({ db: t.db });
/** Il giro dopo: l'esecuzione che aspetta l'invio torna dovuta. */
const tick = async (runId: string) => {
  await t.db.update(automationRuns).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(automationRuns.id, runId));
  await exec();
};
const reload = async (id: string) => (await t.db.select().from(automationRuns).where(eq(automationRuns.id, id)))[0]!;
const mailOf = (runId: string) => t.db.select().from(mailOutgoing).where(eq(mailOutgoing.automationRunId, runId)).orderBy(asc(mailOutgoing.createdAt));
const logOf = (id: string) => t.db.select().from(automationRunLog).where(eq(automationRunLog.runId, id)).orderBy(asc(automationRunLog.seq));
/** Il mittente della Posta, simulato: la riga è partita (o no). */
const settle = (id: string, state: "sent" | "failed", over: { error?: string; threadId?: string } = {}) =>
  t.db
    .update(mailOutgoing)
    .set(state === "sent" ? { state, gmailMessageId: `gm-${id.slice(0, 6)}`, gmailThreadId: over.threadId ?? `th-${id.slice(0, 6)}`, sentAt: new Date() } : { state, error: over.error ?? "other" })
    .where(eq(mailOutgoing.id, id));

describe("l'email di un passo", () => {
  it("parte dalla casella scelta, senza bozza, con la sua chiave; il passo aspetta l'invio; un giro rifatto non scrive una seconda email; inviata → ok col messaggio nel registro", async () => {
    const { run } = await runOf([email()]);
    await exec();
    const [row] = await mailOf(run.id);
    expect(row).toMatchObject({ state: "queued", accountId, userId: ownerId, gmailDraftId: null, subject: "Benvenuto 2026-11-13", body: "Ciao", toAddresses: [{ email: "cliente@b.it", name: null }] });
    expect(row!.rfcMessageId).toMatch(/^<.+@acme\.com>$/);
    expect(row!.sendAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await t.db.select().from(automationEffects).where(eq(automationEffects.idempotencyKey, effectKey(run.id, "0")))).toEqual([expect.objectContaining({ kind: "email", objectId: row!.id })]);
    expect((await reload(run.id)).status).toBe("running");
    // Ancora in coda: un giro (o un riavvio) non scrive una seconda email.
    await tick(run.id);
    expect(await mailOf(run.id)).toHaveLength(1);
    await settle(row!.id, "sent");
    await tick(run.id);
    expect((await reload(run.id)).status).toBe("done");
    const ok = (await logOf(run.id)).find((e) => e.kind === "sendEmail" && e.outcome === "ok");
    expect(ok?.effects).toEqual([{ kind: "email", code: `gm-${row!.id.slice(0, 6)}` }]);
  });

  it("fallita → il passo fallisce col codice del mittente, e nessuno la rimanda da solo; «Riprova» è il gesto che ne scrive una nuova", async () => {
    const { run } = await runOf([email()]);
    await exec();
    const [first] = await mailOf(run.id);
    await settle(first!.id, "failed", { error: "token_expired" });
    await tick(run.id);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "token_expired" });
    await tick(run.id);
    expect(await mailOf(run.id)).toHaveLength(1);
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "retry", byId: ownerId }, byId: ownerId });
    await exec();
    const rows = await mailOf(run.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: "queued" });
    expect((await reload(run.id)).status).toBe("running");
  });

  it("review F2, I1: «Riprova» su un'email che Gmail ha GIÀ mandato (`sent_unrecorded`) non la rimanda: la chiave resta e il registro lo dice", async () => {
    const { run } = await runOf([email()]);
    await exec();
    const [row] = await mailOf(run.id);
    await settle(row!.id, "failed", { error: "sent_unrecorded" });
    await tick(run.id);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "sent_unrecorded" });
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "retry", byId: ownerId }, byId: ownerId });
    await exec();
    expect(await mailOf(run.id)).toHaveLength(1);
    expect((await reload(run.id)).status).toBe("failed");
    const last = (await logOf(run.id)).at(-1)!;
    expect(last.why).toMatchObject({ code: "emailAlreadySent" });
  });

  it("un invio interrotto (il worker morto a metà) è un fallimento, mai rimandato", async () => {
    const { run } = await runOf([email()]);
    await exec();
    const [row] = await mailOf(run.id);
    await settle(row!.id, "failed", { error: "interrupted" });
    await tick(run.id);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "interrupted" });
    expect(await mailOf(run.id)).toHaveLength(1);
  });

  it("la seconda email allo stesso indirizzo nella stessa esecuzione sta nella conversazione della prima; a un altro indirizzo no", async () => {
    const { run } = await runOf([email(), email({ to: " CLIENTE@b.it " }), email({ to: "altro@b.it" })]);
    await exec();
    const [first] = await mailOf(run.id);
    await settle(first!.id, "sent", { threadId: "th-prima" });
    await tick(run.id);
    const second = (await mailOf(run.id))[1]!;
    expect(second.gmailThreadId).toBe("th-prima");
    await settle(second.id, "sent", { threadId: "th-prima" });
    await tick(run.id);
    const third = (await mailOf(run.id))[2]!;
    expect(third.gmailThreadId).toBeNull();
  });

  it("il tetto conta la catena: con 20 email già partite dalle esecuzioni d'origine, la 21ª esce con email_limit", async () => {
    const { run: parent } = await runOf([email()]);
    for (let i = 0; i < 20; i++) {
      await t.db.insert(mailOutgoing).values({ userId: ownerId, accountId, automationRunId: parent.id, sendAt: new Date(), state: "sent", subject: "x", body: "y" });
    }
    const { run } = await runOf([email()], { parentRunId: parent.id });
    await exec();
    expect(await mailOf(run.id)).toEqual([]);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "email_limit" });
  });

  it("«chiede a»: nessuna email prima dell'Approva, nemmeno dopo un riavvio; approvata con le correzioni, parte il testo corretto", async () => {
    const { run } = await runOf([email({ approval: { mode: "ask", who: { owner: true } } })]);
    await exec();
    expect((await reload(run.id)).status).toBe("waiting_approval");
    await tick(run.id);
    expect(await mailOf(run.id)).toEqual([]);
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { kind: "approved", path: "0", byId: ownerId, edited: { subject: "Oggetto corretto", body: "Testo corretto" } }, byId: ownerId });
    await exec();
    const [row] = await mailOf(run.id);
    expect(row).toMatchObject({ subject: "Oggetto corretto", body: "Testo corretto", state: "queued" });
    // In volo dopo l'approvazione: il giro dopo non chiede di nuovo.
    await tick(run.id);
    expect((await reload(run.id)).status).toBe("running");
    await settle(row!.id, "sent");
    await tick(run.id);
    expect((await reload(run.id)).status).toBe("done");
  });

  it("Annulla con un'email ancora in coda: l'esecuzione si chiude e l'email non parte più", async () => {
    const { run } = await runOf([email()]);
    await exec();
    await t.db.insert(automationRunInputs).values({ runId: run.id, input: { control: "cancel", byId: ownerId }, byId: ownerId });
    await exec();
    expect((await reload(run.id)).status).toBe("cancelled");
    expect((await mailOf(run.id))[0]).toMatchObject({ state: "cancelled" });
  });
});

describe("la casella persa a metà (S4, F2-4 = a)", () => {
  it("scollegata fra due passi: il passo dell'email fallisce (mailbox_missing), l'automazione va in pausa (mailbox_lost) e chi la possiede lo sa; nessuna email da un'altra casella", async () => {
    const { automation, run } = await runOf([email()], { mailbox: accountId });
    await t.db.update(googleAccounts).set({ userId: (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id }).where(eq(googleAccounts.id, accountId));
    await exec();
    expect(await mailOf(run.id)).toEqual([]);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "mailbox_missing" });
    const [a] = await t.db.select().from(automations).where(eq(automations.id, automation.id));
    expect(a).toMatchObject({ status: "paused", pausedReason: "mailbox_lost" });
    const cards = await t.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "automation.paused")));
    expect(cards).toHaveLength(1);
  });

  it("scaduta → mailbox_expired; senza lo scope d'invio → mailbox_scope; in pausa in entrambi i casi", async () => {
    await t.db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "invalid_grant" }).where(eq(googleAccounts.id, accountId));
    const { automation, run } = await runOf([email()]);
    await exec();
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "mailbox_expired" });
    expect((await t.db.select().from(automations).where(eq(automations.id, automation.id)))[0]).toMatchObject({ status: "paused", pausedReason: "mailbox_lost" });
    await t.db.update(googleAccounts).set({ disabledAt: null, disabledReason: null, scopes: [] }).where(eq(googleAccounts.id, accountId));
    const second = await runOf([email()]);
    await exec();
    expect(await reload(second.run.id)).toMatchObject({ status: "failed", error: "mailbox_scope" });
  });

  it("review F2, C1: un'esecuzione manda solo dalla SUA casella; passata l'automazione a un altro proprietario, il passo fallisce invece di mandare dalla casella nuova", async () => {
    const { automation, run } = await runOf([email()]);
    await t.db.update(automationRuns).set({ mailboxAccountId: accountId }).where(eq(automationRuns.id, run.id));
    const other = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
    const [ws] = await t.db.insert(googleWorkspaces).values({ name: "W2", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
    const otherBox = (await t.db.insert(googleAccounts).values({ userId: other, workspaceId: ws!.id, email: `b-${randomUUID().slice(0, 5)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [GMAIL_MODIFY] }).returning())[0]!.id;
    await t.db.update(automations).set({ ownerId: other, mailboxAccountId: otherBox }).where(eq(automations.id, automation.id));
    await exec();
    expect(await mailOf(run.id)).toEqual([]);
    expect((await reload(run.id)).error).toBe("mailbox_missing");
  });

  it("review F2, M3: un invio rifiutato perché la casella è disabilitata o non leggibile (`account_disabled`) mette in pausa SUBITO", async () => {
    const { automation, run } = await runOf([email()]);
    await exec();
    const [row] = await mailOf(run.id);
    await settle(row!.id, "failed", { error: "account_disabled" });
    await tick(run.id);
    expect(await reload(run.id)).toMatchObject({ status: "failed", error: "account_disabled" });
    expect((await t.db.select().from(automations).where(eq(automations.id, automation.id)))[0]).toMatchObject({ status: "paused", pausedReason: "mailbox_lost" });
  });
});

