import { randomUUID } from "node:crypto";
import {
  emailMessages,
  emailProposalRecipients,
  emailProposals,
  googleAccounts,
  googleWorkspaces,
  notifications,
  projectMembers,
  projects,
  roles,
  users,
  type Db,
} from "@stubwise/db";
import { startTestDb, type TestDb } from "@stubwise/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { publishSharedProposals } from "./publish-shared.js";

/**
 * LA PUBBLICAZIONE DELLE PROPOSTE CONDIVISE (area 6, F2, task 4, D4). I test
 * che contano sono NEGATIVI: chi non deve ricevere la card non la riceve.
 */

let testDb: TestDb;
let db: Db;
let roleId: string;
beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  roleId = (await db.select({ id: roles.id }).from(roles).where(eq(roles.scope, "project")).limit(1))[0]!.id;
}, 120_000);
afterEach(async () => {
  await db.delete(notifications);
  await db.delete(emailProposals);
  await db.delete(emailMessages);
  await db.delete(googleAccounts);
  await db.delete(googleWorkspaces);
  await db.delete(projectMembers);
  await db.delete(projects);
});
afterAll(async () => {
  await testDb.stop();
});

async function user(email: string, role: "member" | "admin" = "member"): Promise<string> {
  return (await db.insert(users).values({ email, passwordHash: "x", role } as typeof users.$inferInsert).returning())[0]!.id;
}
async function mailbox(userId: string, email: string, proposalsEnabled = true) {
  const [ws] = await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  return (await db.insert(googleAccounts).values({ userId, workspaceId: ws!.id, email, googleSub: randomUUID(), refreshTokenEncrypted: "r", proposalsEnabled }).returning())[0]!;
}

async function scenario() {
  const tag = randomUUID().slice(0, 8);
  const addr = (n: string) => `${n}-${tag}@acme.com`;
  const ada = await user(addr("ada"));
  const bruno = await user(addr("bruno"));
  const carla = await user(addr("carla")); // membro, NON destinataria
  const dario = await user(addr("dario")); // destinatario, NON membro
  const eva = await user(addr("eva"), "admin"); // admin, NON destinataria
  const fabio = await user(addr("fabio"), "admin"); // admin E destinatario: membro implicito
  const [project] = await db.insert(projects).values({ name: "Audin", slug: `audin-${tag}`, ingestionKey: randomUUID() }).returning();
  for (const id of [ada, bruno, carla]) await db.insert(projectMembers).values({ projectId: project!.id, userId: id, roleId });
  const box = await mailbox(ada, addr("ada-box"));
  const [message] = await db
    .insert(emailMessages)
    .values({
      accountId: box.id,
      gmailMessageId: `g-${tag}`,
      threadId: `t-${tag}`,
      fromAddress: "cliente@esterno.it",
      toAddresses: [addr("ada"), addr("bruno")],
      ccAddresses: [addr("dario"), addr("fabio")],
      subject: "Export",
      receivedAt: new Date(),
      rfcMessageId: `<${tag}@esterno.it>`,
    })
    .returning();
  const [proposal] = await db
    .insert(emailProposals)
    .values({
      emailMessageId: message!.id,
      projectId: project!.id,
      rfcMessageId: `<${tag}@esterno.it>`,
      audience: "mail_recipients",
      status: "classified",
      classification: { version: 2, summary: "s", actions: [{ type: "create_task", args: { title: "Export CSV", description: "", assigneeId: null, dueDate: null } }] },
    })
    .returning();
  return { tag, addr, ada, bruno, carla, dario, eva, fabio, project: project!, box, message: message!, proposal: proposal! };
}

async function notifiedUsers(): Promise<string[]> {
  return (await db.select({ userId: notifications.userId }).from(notifications)).map((r) => r.userId).sort();
}

describe("publishSharedProposals", () => {
  it("una card per destinatario membro; MAI a un admin non destinatario, a un membro non destinatario, a un destinatario non membro", async () => {
    const s = await scenario();
    const published = await publishSharedProposals({ db, lang: "it" }, s.box.id);
    expect(published).toBe(1);
    // Ada (to, membro), Bruno (to, membro), Fabio (cc, admin: membro implicito E destinatario).
    expect(await notifiedUsers()).toEqual([s.ada, s.bruno, s.fabio].sort());
    const recipients = (await db.select().from(emailProposalRecipients)).map((r) => r.userId).sort();
    expect(recipients).toEqual([s.ada, s.bruno, s.fabio].sort());
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, s.proposal.id));
    expect(row!.status).toBe("proposed");
    // Ogni destinatario ha la SUA notifica, registrata.
    expect((await db.select().from(emailProposalRecipients)).every((r) => r.notificationId !== null)).toBe(true);
  });

  it("B = (b), decisione del maintainer: chi ha spento le proposte sulla sua casella riceve comunque la card condivisa", async () => {
    const s = await scenario();
    await mailbox(s.bruno, s.addr("bruno-box"), false);
    await publishSharedProposals({ db, lang: "it" }, s.box.id);
    expect(await notifiedUsers()).toContain(s.bruno);
  });

  it("la stessa email in due caselle: UNA proposta, una card per persona, mai due", async () => {
    const s = await scenario();
    const brunoBox = await mailbox(s.bruno, s.addr("bruno-box"));
    await db.insert(emailMessages).values({
      accountId: brunoBox.id,
      gmailMessageId: `g2-${s.tag}`,
      threadId: `t2-${s.tag}`,
      fromAddress: "cliente@esterno.it",
      toAddresses: [s.addr("ada"), s.addr("bruno")],
      subject: "Export",
      receivedAt: new Date(),
      rfcMessageId: `<${s.tag}@esterno.it>`,
    });
    await publishSharedProposals({ db, lang: "it" }, s.box.id);
    await publishSharedProposals({ db, lang: "it" }, brunoBox.id);
    const users = await notifiedUsers();
    expect(users.filter((u) => u === s.bruno)).toHaveLength(1);
    expect(users.filter((u) => u === s.ada)).toHaveLength(1);
  });

  it("nessun destinatario membro: la proposta si chiude, nessuna card", async () => {
    const s = await scenario();
    await db.delete(projectMembers).where(eq(projectMembers.projectId, s.project.id));
    await db.update(emailMessages).set({ ccAddresses: [] }).where(eq(emailMessages.id, s.message.id));
    await publishSharedProposals({ db, lang: "it" }, s.box.id);
    expect(await notifiedUsers()).toEqual([]);
    const [row] = await db.select().from(emailProposals).where(eq(emailProposals.id, s.proposal.id));
    expect(row).toMatchObject({ status: "ignored", outcome: { type: "no_recipients" } });
  });

  it("le proposte di prima (`mailbox_owner`) non passano da qui", async () => {
    const s = await scenario();
    await db.update(emailProposals).set({ audience: "mailbox_owner" }).where(eq(emailProposals.id, s.proposal.id));
    expect(await publishSharedProposals({ db, lang: "it" }, s.box.id)).toBe(0);
    expect(await notifiedUsers()).toEqual([]);
  });
});
