import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { driveFiles, driveFolderLinks, driveOpens, googleAccounts, googleWorkspaces, projects, users } from "./schema.js";
import { startTestDb, type TestDb } from "./testing.js";

/**
 * Migrazione 0167 (13 nov 2026, area 6, F5b): i riferimenti a Google Drive
 * nel Drive dei progetti. Un riferimento non ha byte in archiviazione
 * (`storage_key` null) ma ha il suo `google_file_id`; una volta per progetto;
 * il nome può coincidere con quello di un caricato; le cartelle collegate; e
 * l'apertura `via: google`.
 */

let t: TestDb;
beforeAll(async () => {
  t = await startTestDb();
}, 120_000);
afterAll(async () => {
  await t?.stop();
});

async function seed() {
  const [u] = await t.db.insert(users).values({ email: `u-${randomUUID()}@x.it`, passwordHash: "x", role: "member" }).returning();
  const [p] = await t.db.insert(projects).values({ name: "P", slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  const [ws] = await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["x.it"], clientId: "c", clientSecretEncrypted: "s" }).returning();
  const [box] = await t.db.insert(googleAccounts).values({ userId: u!.id, workspaceId: ws!.id, email: `b-${randomUUID()}@x.it`, googleSub: randomUUID(), refreshTokenEncrypted: "r" }).returning();
  return { userId: u!.id, projectId: p!.id, accountId: box!.id };
}

describe("migrazione 0167", () => {
  it("un riferimento Google senza storage_key e senza dimensione; uno di upload li vuole; google_file_id obbligatorio per google", async () => {
    const { userId, projectId } = await seed();
    const [ref] = await t.db.insert(driveFiles).values({ projectId, number: 1, source: "google", name: "Roadmap", mime: "application/vnd.google-apps.document", type: "document", googleFileId: "g1", googleOwner: "ada@x.it", addedBy: userId }).returning();
    expect(ref).toMatchObject({ storageKey: null, sizeBytes: null, hidden: false, unavailable: null, folderLinkId: null, googleAccountId: null });
    await expect(t.db.insert(driveFiles).values({ projectId, number: 2, source: "upload", name: "a.pdf", mime: "application/pdf", type: "pdf", sizeBytes: 1 })).rejects.toThrow();
    await expect(t.db.insert(driveFiles).values({ projectId, number: 3, source: "google", name: "x", mime: "x", type: "other" })).rejects.toThrow();
  });

  it("lo stesso file Google una volta per progetto (vivo); il nome può coincidere con un caricato", async () => {
    const { projectId } = await seed();
    await t.db.insert(driveFiles).values({ projectId, number: 1, source: "upload", name: "Roadmap", mime: "text/plain", type: "other", sizeBytes: 1, storageKey: `k-${randomUUID()}` });
    await t.db.insert(driveFiles).values({ projectId, number: 2, source: "google", name: "Roadmap", mime: "x", type: "document", googleFileId: "g1" });
    await expect(t.db.insert(driveFiles).values({ projectId, number: 3, source: "google", name: "Roadmap 2", mime: "x", type: "document", googleFileId: "g1" })).rejects.toThrow();
    // Tolto (lapide), si può riaggiungere: un riferimento nuovo, un codice nuovo.
    await t.db.execute(sql`update drive_files set deleted_at = now() where project_id = ${projectId} and google_file_id = 'g1'`);
    await t.db.insert(driveFiles).values({ projectId, number: 4, source: "google", name: "Roadmap", mime: "x", type: "document", googleFileId: "g1" });
  });

  it("una cartella collegata una volta per progetto; `unavailable` ammette solo deleted; l'apertura via google", async () => {
    const { userId, projectId, accountId } = await seed();
    const [link] = await t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: "f1", name: "Cliente", linkedBy: userId, accountId }).returning();
    expect(link!.syncedAt).toBeNull();
    await expect(t.db.insert(driveFolderLinks).values({ projectId, googleFolderId: "f1", name: "Cliente", linkedBy: userId, accountId })).rejects.toThrow();
    const [ref] = await t.db.insert(driveFiles).values({ projectId, number: 1, source: "google", name: "Doc", mime: "x", type: "document", googleFileId: "g9", folderLinkId: link!.id }).returning();
    await expect(t.db.execute(sql`update drive_files set unavailable = 'access_lost' where id = ${ref!.id}`)).rejects.toThrow();
    await t.db.execute(sql`update drive_files set unavailable = 'deleted' where id = ${ref!.id}`);
    await t.db.insert(driveOpens).values({ fileId: ref!.id, personId: userId, via: "google" });
  });
});
