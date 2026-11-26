import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DriveFolderLinkGone, insertDriveReference, reattachDriveReferences, tombstoneDriveFiles } from "./drive-references.js";
import { driveFiles, driveFolderLinks, googleAccounts, googleWorkspaces, projects, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0168 (13 nov 2026, area 6, F5b, review del server punto 5):
 * l'indirizzo della casella accanto all'id, scritto da un trigger, perché
 * sopravviva alla FK che mette l'id a NULL quando si scollega Google; il
 * riaggancio alla ricollegazione dello stesso indirizzo da parte della stessa
 * persona. Più i due minori: la lapide di un riferimento è già «purgata», e
 * un riferimento di una cartella scollegata non entra.
 */

let t: TestDb;
let ws: string;
beforeAll(async () => {
  t = await startTestDb();
  ws = (await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning())[0]!.id;
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function person() {
  const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  return u!.id;
}
async function box(userId: string, email = `b-${randomUUID()}@x.it`) {
  const [b] = await t.db.insert(googleAccounts).values({ userId, workspaceId: ws, email, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  return b!;
}
async function project() {
  const [p] = await t.db.insert(projects).values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return p!.id;
}
const file = (id: string) => ({ id, name: `File ${id}`, mimeType: "application/vnd.google-apps.document", sizeBytes: null, owner: null, modifiedAt: null });

describe("migrazione 0168", () => {
  it("il trigger scrive l'indirizzo della casella a ogni scrittura dell'id, e lo tiene quando la FK mette l'id a NULL", async () => {
    const userId = await person();
    const projectId = await project();
    const b = await box(userId);
    const [link] = await t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: "f1", name: "C", linkedBy: userId, accountId: b.id }).returning();
    const fileId = await insertDriveReference(t.db, { projectId, addedBy: userId, googleAccountId: b.id, folderLinkId: link!.id, file: file("g1"), type: "document", extractable: false });
    expect(link!.accountEmail).toBe(b.email);
    await t.db.delete(googleAccounts).where(eq(googleAccounts.id, b.id));
    const [l] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, link!.id));
    const [f] = await t.db.select().from(driveFiles).where(eq(driveFiles.id, fileId));
    expect(l).toMatchObject({ accountId: null, accountEmail: b.email });
    expect(f).toMatchObject({ googleAccountId: null, googleAccountEmail: b.email });
  });

  it("ricollegare lo STESSO indirizzo dalla STESSA persona riaggancia cartelle e riferimenti (e chiede la sincronizzazione); di un altro, o un altro indirizzo, no", async () => {
    const ada = await person();
    const bob = await person();
    const projectId = await project();
    const email = `ada-${randomUUID()}@x.it`;
    const first = await box(ada, email);
    const other = await box(bob);
    const [link] = await t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: `f-${randomUUID()}`, name: "C", linkedBy: ada, accountId: first.id }).returning();
    const [bobLink] = await t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: `f-${randomUUID()}`, name: "D", linkedBy: bob, accountId: other.id }).returning();
    const mine = await insertDriveReference(t.db, { projectId, addedBy: ada, googleAccountId: first.id, folderLinkId: null, file: file(`g-${randomUUID()}`), type: "document", extractable: false });
    // Un file di Bob rimasto con lo stesso indirizzo (lo aveva lui, prima): resta di Bob.
    const [bobs] = await t.db.insert(driveFiles).values({ projectId, number: 900, source: "google", name: "Di Bob", mime: "application/vnd.google-apps.document", type: "document", googleFileId: `g-${randomUUID()}`, addedBy: bob, googleAccountEmail: email }).returning();
    const [bobsLink] = await t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: `f-${randomUUID()}`, name: "E", linkedBy: bob, accountEmail: email }).returning();
    await t.db.delete(googleAccounts).where(eq(googleAccounts.id, first.id));
    await t.db.delete(googleAccounts).where(eq(googleAccounts.id, other.id));
    // Un indirizzo diverso della stessa persona non riaggancia niente.
    const elsewhere = await box(ada);
    expect(await reattachDriveReferences(t.db, { id: elsewhere.id, userId: ada, email: elsewhere.email })).toEqual({ links: 0, files: 0 });
    // Lo stesso indirizzo (anche con maiuscole diverse): sì, solo le sue.
    const again = await box(ada, email.toUpperCase());
    expect(await reattachDriveReferences(t.db, { id: again.id, userId: ada, email: again.email })).toEqual({ links: 1, files: 1 });
    const [l] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, link!.id));
    expect(l!.accountId).toBe(again.id);
    expect(l!.syncRequestedAt).toBeInstanceOf(Date);
    expect((await t.db.select().from(driveFiles).where(eq(driveFiles.id, mine)))[0]!.googleAccountId).toBe(again.id);
    expect((await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, bobLink!.id)))[0]!.accountId).toBeNull();
    expect((await t.db.select().from(driveFiles).where(eq(driveFiles.id, bobs!.id)))[0]!.googleAccountId).toBeNull();
    expect((await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, bobsLink!.id)))[0]!.accountId).toBeNull();
  });

  it("minore: la lapide di un riferimento (senza storage) è già purgata, quella di un caricato no", async () => {
    const userId = await person();
    const projectId = await project();
    const ref = await insertDriveReference(t.db, { projectId, addedBy: userId, googleAccountId: null, folderLinkId: null, file: file("g9"), type: "document", extractable: false });
    const [up] = await t.db.insert(driveFiles).values({ projectId, number: 50, source: "upload", name: "a.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1, storageKey: "k" }).returning();
    await tombstoneDriveFiles(t.db, [ref, up!.id], userId);
    const rows = new Map((await t.db.select().from(driveFiles).where(eq(driveFiles.projectId, projectId))).map((r) => [r.id, r.storagePurged]));
    expect(rows.get(ref)).toBe(true);
    expect(rows.get(up!.id)).toBe(false);
  });

  it("minore: un riferimento di una cartella già scollegata non entra (DriveFolderLinkGone)", async () => {
    const projectId = await project();
    await expect(insertDriveReference(t.db, { projectId, addedBy: null, googleAccountId: null, folderLinkId: randomUUID(), file: file("g10"), type: "document", extractable: false })).rejects.toBeInstanceOf(DriveFolderLinkGone);
    expect(await t.db.select().from(driveFiles).where(eq(driveFiles.projectId, projectId))).toEqual([]);
  });
});
