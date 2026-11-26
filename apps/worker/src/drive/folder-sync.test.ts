import { randomUUID } from "node:crypto";
import { driveContentJobs, driveFiles, driveFolderLinks, encrypt, googleAccounts, googleWorkspaces, projectMembers, roles, users } from "@stubwise/db";
import { seedRepository, startTestDb, type TestDb } from "@stubwise/db/testing";
import type { DriveListedFile } from "@stubwise/google";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DRIVE_READONLY_SCOPE } from "./google-source.js";
import { FOLDER_SYNC_ERROR_BACKOFF_MS, FOLDER_SYNC_EVERY_MS, syncDueFolderLinks, type FolderSyncClient } from "./folder-sync.js";

/**
 * La sincronizzazione delle cartelle Google collegate (area 6, F5b, B5; QB1 =
 * b): chiesta o giornaliera, col lease, con la casella di chi ha collegato;
 * le scadute si saltano; i file nuovi entrano, i cambiati si rileggono, gli
 * spariti diventano `deleted`, i nascosti e gli aggiunti a mano restano.
 */

const KEY = Buffer.alloc(32, 4);
let t: TestDb;
let projectId: string;
let userId: string;
let ws: string;
const tokens: string[] = [];
let listing: DriveListedFile[] = [];
/** Le cartelle per cui Google risponde con un errore (5xx, 429…). */
const failing = new Set<string>();
let refreshes = 0;
const client: FolderSyncClient = {
  refreshAccessToken: async (input) => (refreshes++, { accessToken: `at:${input.refreshToken}`, expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  listFolderFiles: async (input) => {
    if (failing.has(input.folderId)) throw new Error("Google 503");
    tokens.push(input.accessToken);
    return listing.slice(0, input.max);
  },
};
const gfile = (id: string, over: Partial<DriveListedFile> = {}): DriveListedFile => ({ id, name: `File ${id}`, mimeType: "application/vnd.google-apps.document", modifiedAt: new Date("2026-11-10T09:00:00.000Z"), sizeBytes: null, owner: "ada@acme.com", ownerName: "Ada", ...over });

beforeAll(async () => {
  t = await startTestDb();
  ({ projectId } = await seedRepository(t.db));
  userId = (await t.db.insert(users).values({ email: `lead-${randomUUID()}@acme.com`, passwordHash: "x", role: "member" }).returning())[0]!.id;
  await setRole(userId, "project_lead");
  ws = (await t.db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning())[0]!.id;
}, 120_000);
beforeEach(async () => {
  tokens.length = 0;
  listing = [];
  failing.clear();
  refreshes = 0;
  await setRole(userId, "project_lead");
  await t.db.delete(driveContentJobs);
  await t.db.delete(driveFiles);
  await t.db.delete(driveFolderLinks);
  await t.db.delete(googleAccounts);
});
afterAll(async () => {
  await t?.stop();
});

/** Il ruolo di progetto di `user` (`null` = fuori dal progetto). */
async function setRole(user: string, presetKey: string | null) {
  await t.db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user)));
  if (!presetKey) return;
  const [role] = await t.db.select({ id: roles.id }).from(roles).where(eq(roles.presetKey, presetKey));
  await t.db.insert(projectMembers).values({ projectId, userId: user, roleId: role!.id });
}

async function linkWith(over: { scopes?: string[]; disabled?: boolean; syncedAt?: Date | null; syncRequestedAt?: Date | null; leaseUntil?: Date | null } = {}) {
  const [box] = await t.db.insert(googleAccounts).values({ userId, workspaceId: ws, email: `box-${randomUUID().slice(0, 6)}@acme.com`, googleSub: randomUUID(), refreshTokenEncrypted: encrypt("rt-lead", KEY), scopes: over.scopes ?? ["openid", DRIVE_READONLY_SCOPE], ...(over.disabled ? { disabledAt: new Date(), disabledReason: "invalid_grant" } : {}) }).returning();
  const [link] = await t.db
    .insert(driveFolderLinks)
    .values({ projectId, googleFolderId: `folder-${randomUUID()}`, name: "Cliente", linkedBy: userId, accountId: box!.id, syncedAt: over.syncedAt ?? null, syncRequestedAt: over.syncRequestedAt === undefined ? new Date() : over.syncRequestedAt, leaseUntil: over.leaseUntil ?? null })
    .returning();
  return link!;
}
const refsOf = async () => t.db.select().from(driveFiles);
const deps = (over: { now?: Date; maxFiles?: number } = {}) => ({ db: t.db, encryptionKey: KEY, client, ...(over.now ? { now: () => over.now! } : {}), ...(over.maxFiles ? { maxFiles: over.maxFiles } : {}) });

describe("syncDueFolderLinks", () => {
  it("una richiesta: i file della cartella entrano come riferimenti (aggiunti da chi ha collegato, letti con la SUA casella), col job del contenuto; la richiesta si chiude", async () => {
    const link = await linkWith();
    listing = [gfile("a"), gfile("b", { mimeType: "application/vnd.google-apps.form" })];
    expect(await syncDueFolderLinks(deps())).toBe(1);
    expect(tokens).toEqual(["at:rt-lead"]);
    const refs = await refsOf();
    expect(refs.map((r) => [r.googleFileId, r.folderLinkId, r.addedBy, r.googleAccountId, r.contentStatus]).sort()).toEqual([
      ["a", link.id, userId, link.accountId, "pending"],
      ["b", link.id, userId, link.accountId, "unsupported"],
    ]);
    expect(await t.db.select().from(driveContentJobs)).toHaveLength(1);
    const [after] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, link.id));
    expect(after).toMatchObject({ syncRequestedAt: null, leaseUntil: null, syncError: null });
    expect(after!.syncedAt).toBeInstanceOf(Date);
  });

  it("il giro dopo: un file cambiato si rilegge, uno sparito diventa deleted (e perde il testo), un nascosto resta nascosto, uno aggiunto a mano resta com'è", async () => {
    const link = await linkWith();
    listing = [gfile("a"), gfile("b"), gfile("c")];
    await syncDueFolderLinks(deps());
    await t.db.update(driveFiles).set({ contentStatus: "ready", contentText: "testo di b" }).where(eq(driveFiles.googleFileId, "b"));
    await t.db.update(driveFiles).set({ hidden: true }).where(eq(driveFiles.googleFileId, "c"));
    await t.db.insert(driveFiles).values({ projectId, number: 99, source: "google", name: "A mano", mime: "application/vnd.google-apps.document", type: "document", googleFileId: "d" });
    await t.db.delete(driveContentJobs);
    listing = [gfile("a", { modifiedAt: new Date("2026-11-12T09:00:00.000Z") }), gfile("c"), gfile("d")];
    await t.db.update(driveFolderLinks).set({ syncRequestedAt: new Date() }).where(eq(driveFolderLinks.id, link.id));
    await syncDueFolderLinks(deps());
    const by = new Map((await refsOf()).map((r) => [r.googleFileId, r]));
    expect(by.get("a")).toMatchObject({ contentStatus: "pending" });
    expect(by.get("b")).toMatchObject({ unavailable: "deleted", contentText: null });
    expect(by.get("c")).toMatchObject({ hidden: true, unavailable: null });
    expect(by.get("d")).toMatchObject({ folderLinkId: null, name: "A mano" });
    expect((await t.db.select().from(driveContentJobs)).length).toBe(1);
  });

  it("una lista TAGLIATA dal tetto non fa sparire niente", async () => {
    await linkWith();
    listing = [gfile("a"), gfile("b")];
    await syncDueFolderLinks(deps());
    listing = [gfile("x"), gfile("y"), gfile("z")];
    await t.db.update(driveFolderLinks).set({ syncRequestedAt: new Date() });
    await syncDueFolderLinks(deps({ maxFiles: 2 }));
    expect((await refsOf()).filter((r) => r.unavailable === "deleted")).toEqual([]);
  });

  it("QB1 = b: una volta al giorno da sola; prima del giorno no; col lease di un altro giro no", async () => {
    const now = new Date();
    await linkWith({ syncRequestedAt: null, syncedAt: new Date(now.getTime() - FOLDER_SYNC_EVERY_MS + 3600_000) });
    expect(await syncDueFolderLinks(deps({ now }))).toBe(0);
    const old = await linkWith({ syncRequestedAt: null, syncedAt: new Date(now.getTime() - FOLDER_SYNC_EVERY_MS - 3600_000) });
    await linkWith({ leaseUntil: new Date(now.getTime() + 60_000) });
    expect(await syncDueFolderLinks(deps({ now }))).toBe(1);
    const [after] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, old.id));
    expect(after!.syncedAt!.getTime()).toBe(now.getTime());
  });

  it("una cartella SCADUTA (casella disattivata o senza drive.readonly) non si legge: Google non viene chiamato, la richiesta resta", async () => {
    const disabled = await linkWith({ disabled: true });
    await linkWith({ scopes: ["openid"] });
    expect(await syncDueFolderLinks(deps())).toBe(0);
    expect(tokens).toEqual([]);
    expect(refreshes).toBe(0);
    const [after] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, disabled.id));
    expect(after).toMatchObject({ leaseUntil: null });
    expect(after!.syncRequestedAt).toBeInstanceOf(Date);
  });

  it("review 1: le scadute restano FUORI dal claim, quindi più del tetto di scadute non ferma una cartella sana", async () => {
    for (let i = 0; i < 3; i++) await linkWith({ disabled: true, syncRequestedAt: null });
    for (let i = 0; i < 3; i++) await linkWith({ scopes: ["openid"], syncRequestedAt: null });
    const healthy = await linkWith({ syncRequestedAt: null, syncedAt: new Date(Date.now() - FOLDER_SYNC_EVERY_MS - 3600_000) });
    listing = [gfile("a")];
    expect(await syncDueFolderLinks({ ...deps(), maxLinks: 5 })).toBe(1);
    const [after] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, healthy.id));
    expect(after!.syncError).toBeNull();
    expect((await refsOf()).map((r) => r.googleFileId)).toEqual(["a"]);
  });

  it("review 1: una cartella in errore non si riprova al giro dopo (backoff), ma dopo il backoff sì; l'errore resta scritto", async () => {
    const now = new Date();
    const broken = await linkWith();
    failing.add(broken.googleFolderId);
    expect(await syncDueFolderLinks(deps({ now }))).toBe(0);
    expect(refreshes).toBe(1);
    expect(await syncDueFolderLinks(deps({ now: new Date(now.getTime() + 10_000) }))).toBe(0);
    expect(refreshes).toBe(1);
    const [mid] = await t.db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, broken.id));
    expect(mid!.syncError).toBe("Google 503");
    expect(mid!.syncRequestedAt).toBeInstanceOf(Date);
    failing.clear();
    listing = [gfile("a")];
    expect(await syncDueFolderLinks(deps({ now: new Date(now.getTime() + FOLDER_SYNC_ERROR_BACKOFF_MS + 1000) }))).toBe(1);
    expect(refreshes).toBe(2);
  });

  it("review 4: chi ha collegato è uscito dal progetto, o non ha più drive.manage: la cartella è scaduta e non si sincronizza; rimesso il permesso, torna", async () => {
    await linkWith();
    listing = [gfile("a")];
    await setRole(userId, null);
    expect(await syncDueFolderLinks(deps())).toBe(0);
    await setRole(userId, "developer");
    expect(await syncDueFolderLinks(deps())).toBe(0);
    expect(refreshes).toBe(0);
    await setRole(userId, "project_lead");
    expect(await syncDueFolderLinks(deps())).toBe(1);
  });

  it("minore: un file spostato da una cartella collegata a un'altra dello stesso progetto passa alla seconda (non resta deleted)", async () => {
    const first = await linkWith();
    listing = [gfile("a")];
    await syncDueFolderLinks(deps());
    const second = await linkWith({ syncRequestedAt: null, syncedAt: new Date() });
    listing = [];
    await t.db.update(driveFolderLinks).set({ syncRequestedAt: new Date() }).where(eq(driveFolderLinks.id, first.id));
    await syncDueFolderLinks(deps());
    expect((await refsOf())[0]).toMatchObject({ folderLinkId: first.id, unavailable: "deleted" });
    listing = [gfile("a", { modifiedAt: new Date("2026-11-12T09:00:00.000Z") })];
    await t.db.update(driveFolderLinks).set({ syncRequestedAt: new Date() }).where(eq(driveFolderLinks.id, second.id));
    await syncDueFolderLinks(deps());
    const refs = await refsOf();
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ folderLinkId: second.id, googleAccountId: second.accountId, unavailable: null, contentStatus: "pending" });
  });

  it("minore: scollegata a metà giro, i file che arrivano dopo non entrano come «manuali» orfani", async () => {
    const link = await linkWith();
    listing = [gfile("a"), gfile("b")];
    const unlinking: FolderSyncClient = {
      ...client,
      listFolderFiles: async (input) => {
        const out = await client.listFolderFiles(input);
        await t.db.delete(driveFolderLinks).where(eq(driveFolderLinks.id, link.id));
        return out;
      },
    };
    expect(await syncDueFolderLinks({ ...deps(), client: unlinking })).toBe(0);
    expect(await refsOf()).toEqual([]);
  });
});
