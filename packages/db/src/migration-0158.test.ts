import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleAccounts, googleWorkspaces, mailDraftAttachments, mailDrafts, storageOrphans, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0158 (review della F3, punto 1): un allegato caricato dal disco
 * che se ne va — bozza mandata, eliminata, annullata con lo slot occupato, o
 * la cascata da casella o persona eliminate — lascia il suo oggetto in
 * `storage_orphans` nella STESSA transazione; il purge del server lo toglie.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function draftWithFiles() {
  const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@x.it`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  const [draft] = await t.db.insert(mailDrafts).values({ userId: u!.id, accountId: box!.id, gmailDraftId: `g-${randomUUID()}`, mode: "new" }).returning();
  const key = `mail/${draft!.id}/${randomUUID()}`;
  await t.db.insert(mailDraftAttachments).values([
    { draftId: draft!.id, name: "nota.txt", sizeBytes: 1, mimeType: "text/plain", storageKey: key },
    // Senza oggetto nostro (come un file del Drive): niente orfano.
    { draftId: draft!.id, name: "senza-oggetto.pdf", sizeBytes: 1, mimeType: "application/pdf" },
  ]);
  return { user: u!, box: box!, draft: draft!, key };
}
const orphanKeys = async () => (await t.db.select().from(storageOrphans)).map((o) => o.storageKey);

describe("migrazione 0158", () => {
  it("eliminare la bozza: l'oggetto dal disco va fra gli orfani; quello del Drive no (non è nostro)", async () => {
    const { draft, key } = await draftWithFiles();
    await t.db.delete(mailDrafts).where(eq(mailDrafts.id, draft.id));
    expect(await orphanKeys()).toContain(key);
    expect((await t.db.select().from(storageOrphans).where(eq(storageOrphans.storageKey, key)))[0]!.reason).toBe("mail_draft_attachment");
    expect((await orphanKeys()).every((k) => k !== "" && k !== null)).toBe(true);
  });

  it("la cascata da una casella eliminata, e da una persona eliminata", async () => {
    const a = await draftWithFiles();
    await t.db.delete(googleAccounts).where(eq(googleAccounts.id, a.box.id));
    const b = await draftWithFiles();
    await t.db.delete(users).where(eq(users.id, b.user.id));
    const keys = await orphanKeys();
    expect(keys).toContain(a.key);
    expect(keys).toContain(b.key);
  });
});
