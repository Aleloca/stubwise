import { randomUUID } from "node:crypto";
import {
  automationEvents,
  automationRunInputs,
  automationRuns,
  automations,
  automationVersions,
  googleAccounts,
  googleWorkspaces,
  mailOutgoing,
  projectMembers,
  roles,
  tickets,
  users,
} from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { AutomationFlow, Step } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumeAutomationEvents } from "./consumer.js";
import { executeDueRuns } from "./executor.js";
import { automationMailIn } from "./mail-in.js";

/**
 * L'INIZIO «EMAIL IN ARRIVO» (area 7, F2, S8; C-F2-0, C-F2-5): TUTTE le email
 * ricevute dalla casella dell'automazione, solo del proprietario
 * (`mailbox_owner`, admin compresi), una volta per messaggio; mai una risposta
 * nella conversazione in cui la stessa automazione ha mandato un'email (il
 * botta e risposta), che invece ne sveglia le attese.
 */

const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
let t: TestDb;
let projectId: string;
let ownerId: string;
let mailbox: string;
let seq = 1;

beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person(role = "project_lead") {
  const id = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning())[0]!.id;
  const [r] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, role));
  await t.db.insert(projectMembers).values({ projectId, userId: id, roleId: r!.id });
  return id;
}
async function boxOf(userId: string) {
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "W", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  return (await t.db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email: `b-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: "r", scopes: [GMAIL_MODIFY] }).returning())[0]!.id;
}

beforeEach(async () => {
  ({ projectId } = await seedRepository(t.db));
  ownerId = await person();
  mailbox = await boxOf(ownerId);
});

const task: Step = { id: "t", kind: "createTask", title: "Da {{email.mittente}}: {{email.oggetto}}", description: "{{email.testo}}", assignee: null, dueInDays: null, project: { mode: "own" }, milestoneRef: null, approval: { mode: "auto" } };

async function listening(over: { owner?: string; box?: string; steps?: Step[]; filter?: AutomationFlow["trigger"] } = {}) {
  const n = seq++;
  const flow: AutomationFlow = { trigger: over.filter ?? { kind: "stubwise", event: "mail_received" }, steps: over.steps ?? [task], titleTemplate: "Email da {{email.mittente}}" };
  const [a] = await t.db
    .insert(automations)
    .values({ code: `I${n}-A${n}`, seq: n, name: `In ${n}`, projectId, ownerId: over.owner ?? ownerId, status: "active", activeSince: new Date(Date.now() - 60_000), mailboxAccountId: over.box ?? mailbox, listensMail: (over.filter ?? { kind: "stubwise", event: "mail_received" }).kind === "stubwise" })
    .returning();
  await t.db.insert(automationVersions).values({ automationId: a!.id, n: 1, flow, publishedAt: new Date(Date.now() - 60_000), publishedBy: ownerId });
  return a!;
}

const message = (over: Partial<{ accountId: string; gmailMessageId: string; threadId: string; from: string; subject: string }> = {}) => ({
  accountId: mailbox,
  gmailMessageId: `gm-${randomUUID().slice(0, 8)}`,
  threadId: `th-${randomUUID().slice(0, 8)}`,
  from: "cliente@b.it",
  subject: "Preventivo",
  ...over,
});
const runsOf = (id: string) => t.db.select().from(automationRuns).where(eq(automationRuns.automationId, id));

describe("«email in arrivo»", () => {
  it("un'email ricevuta nella casella dell'automazione la fa partire coi campi dell'email; il testo poi si toglie dall'evento", async () => {
    const a = await listening();
    let reads = 0;
    await automationMailIn(t.db, message(), async () => {
      reads++;
      return "Vorrei un preventivo";
    });
    expect(reads).toBe(1);
    await consumeAutomationEvents({ db: t.db });
    const [run] = await runsOf(a.id);
    expect(run).toMatchObject({ origin: "stubwise", title: "Email da cliente@b.it", event: { email: { mittente: "cliente@b.it", oggetto: "Preventivo", testo: "Vorrei un preventivo" } } });
    await executeDueRuns({ db: t.db });
    const [created] = await t.db.select().from(tickets).where(eq(tickets.automationRunId, run!.id));
    expect(created).toMatchObject({ title: "Da cliente@b.it: Preventivo" });
    const [event] = await t.db.select().from(automationEvents).where(eq(automationEvents.accountId, mailbox));
    expect((event!.payload as { email: { testo: string } }).email.testo).toBe("");
  });

  it("review F2, I2: una casella con un'automazione che manda SOLTANTO (non ascolta): zero download e zero eventi", async () => {
    await listening({ filter: { kind: "manual" } });
    let reads = 0;
    await automationMailIn(t.db, message(), async () => {
      reads++;
      return "x";
    });
    expect(reads).toBe(0);
    expect(await t.db.select().from(automationEvents).where(eq(automationEvents.accountId, mailbox))).toEqual([]);
  });

  it("lo stesso messaggio riletto (la history due volte) non la fa ripartire", async () => {
    const a = await listening();
    const m = message();
    await automationMailIn(t.db, m, async () => "x");
    await automationMailIn(t.db, m, async () => "x");
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toHaveLength(1);
  });

  it("nessuno ascolta e nessuno aspetta: la posta non si legge (niente testo scaricato, niente evento)", async () => {
    let reads = 0;
    await automationMailIn(t.db, message(), async () => {
      reads++;
      return "x";
    });
    expect(reads).toBe(0);
    expect(await t.db.select().from(automationEvents).where(eq(automationEvents.accountId, mailbox))).toEqual([]);
  });

  it("mailbox_owner (test NEGATIVO): un'email nella casella di un altro non la fa partire, nemmeno se il proprietario è admin", async () => {
    const admin = (await t.db.insert(users).values({ email: `${randomUUID()}@x.it`, passwordHash: "x", role: "admin" }).returning())[0]!.id;
    // Un'automazione dell'admin che (per un dato sporco) punta alla casella di un altro.
    const a = await listening({ owner: admin });
    await automationMailIn(t.db, message(), async () => "privata");
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toEqual([]);
    // Un'altra casella, nessuna automazione la ascolta: niente.
    const other = await boxOf(await person());
    const mine = await listening();
    await automationMailIn(t.db, message({ accountId: other }), async () => "altrui");
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(mine.id)).toEqual([]);
  });

  it("il filtro dell'inizio decide", async () => {
    const a = await listening({ filter: { kind: "stubwise", event: "mail_received", filter: { left: { ref: "email.oggetto" }, op: "contains", right: { value: "Urgente" } } } });
    await automationMailIn(t.db, message({ subject: "Ciao" }), async () => "x");
    await automationMailIn(t.db, message({ subject: "Urgente: rotto" }), async () => "x");
    await consumeAutomationEvents({ db: t.db });
    expect((await runsOf(a.id)).map((r) => (r.event as { email: { oggetto: string } }).email.oggetto)).toEqual(["Urgente: rotto"]);
  });

  it("C-F2-5, il botta e risposta: una risposta nella conversazione in cui l'automazione ha mandato un'email NON la fa ripartire ma sveglia la sua attesa; un'altra automazione della casella parte; fuori da quella conversazione riparte", async () => {
    const a = await listening();
    const b = await listening();
    // Un'esecuzione di A ha mandato un'email nella conversazione th-ping e ne aspetta la risposta.
    const [run] = await t.db
      .insert(automationRuns)
      .values({ automationId: a.id, n: 50, version: 1, title: "Ping", origin: "stubwise", status: "waiting_event", mailboxAccountId: mailbox, waitingThread: `${mailbox}:th-ping`, cursor: { path: "1", waitingUntil: new Date(Date.now() + 86_400_000).toISOString() } })
      .returning();
    await t.db.update(automationVersions).set({ flow: { trigger: { kind: "stubwise", event: "mail_received" }, steps: [{ id: "m", kind: "sendEmail", to: "x@b.it", subject: "s", body: "b", attachRefs: [], approval: { mode: "auto" } }, { id: "w", kind: "wait", for: { replyTo: "m", maxDays: 3 } }], titleTemplate: "t" } }).where(eq(automationVersions.automationId, a.id));
    await t.db.insert(mailOutgoing).values({ userId: ownerId, accountId: mailbox, automationRunId: run!.id, sendAt: new Date(), state: "sent", gmailThreadId: "th-ping", subject: "s", body: "b" });
    // Il risponditore automatico risponde nella conversazione.
    await automationMailIn(t.db, message({ threadId: "th-ping", from: "autoreply@b.it" }), async () => "Sono in ferie");
    await consumeAutomationEvents({ db: t.db });
    expect((await runsOf(a.id)).map((r) => r.n)).toEqual([50]);
    expect(await runsOf(b.id)).toHaveLength(1);
    const woken = await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run!.id));
    expect(woken.map((i) => i.input)).toEqual([{ kind: "event", payload: { kind: "reply", to: "m", text: "Sono in ferie" } }]);
    // Un'email in un'altra conversazione: A riparte.
    await automationMailIn(t.db, message({ threadId: "th-nuova" }), async () => "Nuova richiesta");
    await consumeAutomationEvents({ db: t.db });
    expect(await runsOf(a.id)).toHaveLength(2);
  });

  it("review F2, C1: passata a un altro proprietario (e alla sua casella), una risposta nella casella di A non sveglia più l'esecuzione", async () => {
    const a = await listening();
    const [run] = await t.db
      .insert(automationRuns)
      .values({ automationId: a.id, n: 70, version: 1, title: "R", origin: "stubwise", status: "waiting_event", mailboxAccountId: mailbox, waitingThread: `${mailbox}:th-c1`, cursor: { path: "1", waitingUntil: new Date(Date.now() + 86_400_000).toISOString() } })
      .returning();
    await t.db.update(automationVersions).set({ flow: { trigger: { kind: "stubwise", event: "mail_received" }, steps: [{ id: "m", kind: "sendEmail", to: "x@b.it", subject: "s", body: "b", attachRefs: [], approval: { mode: "auto" } }, { id: "w", kind: "wait", for: { replyTo: "m", maxDays: 3 } }], titleTemplate: "t" } }).where(eq(automationVersions.automationId, a.id));
    const b = await person();
    await t.db.update(automations).set({ ownerId: b, mailboxAccountId: await boxOf(b) }).where(eq(automations.id, a.id));
    await automationMailIn(t.db, message({ threadId: "th-c1" }), async () => "Risposta per A");
    expect(await t.db.select().from(automationRunInputs).where(eq(automationRunInputs.runId, run!.id))).toEqual([]);
  });
});

