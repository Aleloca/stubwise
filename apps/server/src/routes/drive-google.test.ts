import { randomUUID } from "node:crypto";
import { driveContentJobs, driveFiles, driveFolderLinks, driveOpens, encrypt, googleAccounts, googleWorkspaces, projects, type Db } from "@stubwise/db";
import type { TestDb } from "@stubwise/db/testing";
import { startTestDb } from "@stubwise/db/testing";
import { GoogleApiError, type DriveFileMeta, type DriveListedFile } from "@stubwise/google";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { DriveGoogleClient } from "../drive/google.js";
import { addMember, createUserWithSession, seedUsers } from "../test/fixtures.js";

/**
 * GOOGLE DRIVE NEL DRIVE DEI PROGETTI (area 6, F5b): il picker legge il MIO
 * Drive, un riferimento entra una volta per progetto, le cartelle le collega
 * chi ha `drive.manage`, «scaduta» e «accesso perso» si derivano dalla
 * casella di chi ha collegato, «Togli» contro «Nascondi», «Apri» va su Google.
 */

const KEY = Buffer.alloc(32, 2);
const DRIVE = "https://www.googleapis.com/auth/drive.readonly";
let testDb: TestDb;
let db: Db;
let app: FastifyInstance;
let adminCookie: string;
const tokensUsed: string[] = [];
let files: DriveListedFile[] = [];
let metas: Record<string, Partial<DriveFileMeta> | Error> = {};

const fake: DriveGoogleClient = {
  refreshAccessToken: async (input) => ({ accessToken: `at:${input.refreshToken}`, expiresInSeconds: 3600, refreshToken: null, scopes: [], tokenType: "Bearer", idToken: null }),
  listDriveFiles: async (input) => (tokensUsed.push(input.accessToken), { files, nextPageToken: null }),
  listDriveFolders: async (input) => (tokensUsed.push(input.accessToken), { files: [{ id: "folder-1", name: "Cliente", mimeType: "application/vnd.google-apps.folder", modifiedAt: null, sizeBytes: null, owner: null, ownerName: null }], nextPageToken: null }),
  getDriveFile: async (input) => {
    tokensUsed.push(input.accessToken);
    const over = metas[input.fileId];
    if (over instanceof Error) throw over;
    if (!over) throw new GoogleApiError({ api: "drive.files.get", status: 404, code: "file_not_found", reason: "notFound" });
    return { id: input.fileId, name: "Roadmap", mimeType: "application/vnd.google-apps.document", trashed: false, createdTime: new Date(), owners: ["ada@acme.com"], ...over };
  },
};

beforeAll(async () => {
  testDb = await startTestDb();
  db = testDb.db;
  app = buildApp({ db, sessionSecret: "segreto-di-test-lungo-almeno-32-caratteri!!", encryptionKey: KEY.toString("base64"), driveGoogleClient: fake });
  ({ adminCookie } = await seedUsers(app));
}, 120_000);
beforeEach(() => {
  tokensUsed.length = 0;
  files = [];
  metas = {};
});
afterAll(async () => {
  await app.close();
  await testDb.stop();
});

let ws: string | null = null;
async function person(opts: { scopes?: string[]; mailbox?: boolean } = {}) {
  const email = `p-${randomUUID().slice(0, 8)}@acme.com`;
  const user = await createUserWithSession(app, email);
  if (opts.mailbox === false) return { ...user, email, accountId: null as string | null };
  if (!ws) ws = (await db.insert(googleWorkspaces).values({ name: "A", domains: ["acme.com"], clientId: "c", clientSecretEncrypted: encrypt("s", KEY) }).returning())[0]!.id;
  const [box] = await db.insert(googleAccounts).values({ userId: user.id, workspaceId: ws, email, googleSub: randomUUID(), refreshTokenEncrypted: encrypt(`rt-${email}`, KEY), scopes: opts.scopes ?? ["openid", DRIVE] }).returning();
  return { ...user, email, accountId: box!.id as string | null };
}
async function project() {
  const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  const [p] = await db.insert(projects).values({ name: `P ${code}`, code, slug: `p-${randomUUID()}`, ingestionKey: randomUUID() }).returning();
  return { id: p!.id, code };
}

const call = (headers: { cookie: string }, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => app.inject({ method, url: `/api${url}`, headers, ...(payload ? { payload } : {}) });

describe("il picker e l'aggiunta di un file", () => {
  it("il picker legge il MIO Drive (col mio token) e dice cosa c'è già; serve drive.upload", async () => {
    const p = await project();
    const ada = await person();
    const viewer = await person();
    await addMember(app, p.id, ada.id, "legacy_member");
    await addMember(app, p.id, viewer.id, "viewer");
    files = [{ id: "g1", name: "Roadmap", mimeType: "application/vnd.google-apps.document", modifiedAt: new Date(), sizeBytes: null, owner: "ada@acme.com", ownerName: "Ada" }];
    const res = await call(ada.headers, "GET", `/projects/${p.id}/drive/google/files?q=road`);
    expect(res.json().items).toEqual([expect.objectContaining({ googleFileId: "g1", type: "document", alreadyInProject: false })]);
    expect(tokensUsed).toEqual([`at:rt-${ada.email}`]);
    expect((await call(viewer.headers, "GET", `/projects/${p.id}/drive/google/files`)).statusCode).toBe(403);
  });

  it("senza casella: google_not_connected; con la casella senza drive.readonly: google_scope_missing col missing", async () => {
    const p = await project();
    const none = await person({ mailbox: false });
    const narrow = await person({ scopes: ["openid"] });
    for (const u of [none, narrow]) await addMember(app, p.id, u.id, "legacy_member");
    expect((await call(none.headers, "GET", `/projects/${p.id}/drive/google/files`)).json()).toMatchObject({ code: "google_not_connected" });
    const res = await call(narrow.headers, "GET", `/projects/${p.id}/drive/google/files`);
    expect([res.statusCode, res.json().code, res.json().missing]).toEqual([409, "google_scope_missing", expect.arrayContaining([DRIVE])]);
  });

  it("aggiungere: un riferimento col codice del progetto, letto con la MIA casella, in elaborazione; una seconda volta already_in_project; in un altro progetto un codice nuovo", async () => {
    const p = await project();
    const q = await project();
    const ada = await person();
    await addMember(app, p.id, ada.id, "legacy_member");
    await addMember(app, q.id, ada.id, "legacy_member");
    metas = { g1: { name: "Roadmap" } };
    const res = await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "g1" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: "google", code: `${p.code}-F1`, googleFileId: "g1", googleOwner: "ada@acme.com", sizeBytes: null, contentStatus: "pending", folder: null, unavailable: null, permissions: { remove: true, delete: false, hide: false } });
    const [row] = await db.select().from(driveFiles).where(eq(driveFiles.id, res.json().id));
    expect(row).toMatchObject({ googleAccountId: ada.accountId, storageKey: null });
    expect(await db.select().from(driveContentJobs).where(eq(driveContentJobs.fileId, row!.id))).toHaveLength(1);
    const again = await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "g1" });
    expect([again.statusCode, again.json().code]).toEqual([409, "already_in_project"]);
    const other = await call(ada.headers, "POST", `/projects/${q.id}/drive/google/files`, { googleFileId: "g1" });
    expect(other.json().code).toBe(`${q.code}-F1`);
    expect((await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "nessuno" })).statusCode).toBe(404);
  });
});

describe("le cartelle collegate", () => {
  async function linked() {
    const p = await project();
    const lead = await person();
    const dev = await person();
    await addMember(app, p.id, lead.id, "project_lead");
    await addMember(app, p.id, dev.id, "legacy_member");
    metas = { "folder-1": { name: "Cliente", mimeType: "application/vnd.google-apps.folder" } };
    const res = await call(lead.headers, "POST", `/projects/${p.id}/drive/google/folders`, { googleFolderId: "folder-1" });
    expect(res.statusCode).toBe(201);
    const link = res.json() as { id: string };
    const [ref] = await db.insert(driveFiles).values({ projectId: p.id, number: 1, source: "google", name: "Doc della cartella", mime: "application/vnd.google-apps.document", type: "document", googleFileId: "gf", googleAccountId: lead.accountId, folderLinkId: link.id, addedBy: lead.id }).returning();
    return { p, lead, dev, link, ref: ref! };
  }

  it("collegare vuole drive.manage, una volta per progetto; la sincronizzazione è chiesta al worker", async () => {
    const { p, lead, dev, link } = await linked();
    expect((await call(dev.headers, "POST", `/projects/${p.id}/drive/google/folders`, { googleFolderId: "folder-1" })).statusCode).toBe(403);
    const again = await call(lead.headers, "POST", `/projects/${p.id}/drive/google/folders`, { googleFolderId: "folder-1" });
    expect(again.json().code).toBe("already_linked");
    const [row] = await db.select().from(driveFolderLinks).where(eq(driveFolderLinks.id, link.id));
    expect(row).toMatchObject({ accountId: lead.accountId, linkedBy: lead.id });
    expect(row!.syncRequestedAt).toBeInstanceOf(Date);
    const view = (await call(dev.headers, "GET", `/projects/${p.id}/drive/google/links`)).json().items[0];
    expect(view).toMatchObject({ name: "Cliente", status: "ok", accessLost: false, fileCount: 1, lastSyncedAt: null });
  });

  it("B4: la casella di chi ha collegato disattivata → cartella scaduta e file access_lost (derivati), sync rifiutata; riattivata, tutto torna", async () => {
    const { p, lead, dev, link, ref } = await linked();
    await db.update(googleAccounts).set({ disabledAt: new Date(), disabledReason: "invalid_grant" }).where(eq(googleAccounts.id, lead.accountId!));
    const view = (await call(dev.headers, "GET", `/projects/${p.id}/drive/google/links`)).json().items[0];
    expect(view).toMatchObject({ status: "expired", accessLost: true });
    expect((await call(dev.headers, "GET", `/drive/files/${ref.id}`)).json()).toMatchObject({ unavailable: "access_lost", folder: { status: "expired" } });
    expect((await call(lead.headers, "POST", `/drive/google/folders/${link.id}/sync`)).json().code).toBe("link_expired");
    expect((await call(dev.headers, "GET", `/drive/files/${ref.id}/open`)).statusCode).toBe(409);
    await db.update(googleAccounts).set({ disabledAt: null, disabledReason: null }).where(eq(googleAccounts.id, lead.accountId!));
    expect((await call(dev.headers, "GET", `/drive/files/${ref.id}`)).json()).toMatchObject({ unavailable: null, folder: { status: "ok" } });
  });

  it("Togli contro Nascondi: un file di cartella disponibile si nasconde (use_hide); nascosto, sparisce dall'elenco e dal dettaglio di chi non ha drive.manage", async () => {
    const { p, lead, dev, ref } = await linked();
    expect((await call(lead.headers, "DELETE", `/drive/files/${ref.id}`)).json().code).toBe("use_hide");
    expect((await call(dev.headers, "PUT", `/drive/files/${ref.id}/hidden`, { hidden: true })).statusCode).toBe(403);
    expect((await call(lead.headers, "PUT", `/drive/files/${ref.id}/hidden`, { hidden: true })).json()).toMatchObject({ hidden: true, hiddenBy: { personId: lead.id } });
    expect(((await call(dev.headers, "GET", `/projects/${p.id}/drive/files`)).json().items as { id: string }[]).map((f) => f.id)).not.toContain(ref.id);
    expect((await call(dev.headers, "GET", `/drive/files/${ref.id}`)).statusCode).toBe(404);
    expect(((await call(lead.headers, "GET", `/projects/${p.id}/drive/files?hidden=true`)).json().items as { id: string }[]).map((f) => f.id)).toEqual([ref.id]);
    expect(((await call(dev.headers, "GET", `/projects/${p.id}/drive/files?hidden=true`)).json().items as { id: string }[])).toEqual([]);
  });

  it("scollegare (drive.manage) toglie i suoi file dal progetto", async () => {
    const { lead, dev, link, ref } = await linked();
    expect((await call(dev.headers, "DELETE", `/drive/google/folders/${link.id}`)).statusCode).toBe(403);
    expect((await call(lead.headers, "DELETE", `/drive/google/folders/${link.id}`)).statusCode).toBe(204);
    const [row] = await db.select().from(driveFiles).where(eq(driveFiles.id, ref.id));
    expect(row!.deletedAt).toBeInstanceOf(Date);
  });
});

describe("togliere e aprire un riferimento", () => {
  it("«Togli» un file aggiunto a mano: chi l'ha aggiunto sì, un altro senza drive.manage no; su Google non cambia nulla", async () => {
    const p = await project();
    const ada = await person();
    const bob = await person();
    for (const u of [ada, bob]) await addMember(app, p.id, u.id, "legacy_member");
    metas = { g1: {} };
    const added = (await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "g1" })).json() as { id: string };
    expect((await call(bob.headers, "DELETE", `/drive/files/${added.id}`)).statusCode).toBe(403);
    expect((await call(ada.headers, "DELETE", `/drive/files/${added.id}`)).statusCode).toBe(204);
    const [row] = await db.select().from(driveFiles).where(eq(driveFiles.id, added.id));
    expect(row!.deletedAt).toBeInstanceOf(Date);
  });

  it("«Apri in Google Drive»: 302 sul Doc, l'apertura conta via google; un caricato non si apre così, un riferimento non si scarica", async () => {
    const p = await project();
    const ada = await person();
    await addMember(app, p.id, ada.id, "legacy_member");
    metas = { g1: {} };
    const added = (await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "g1" })).json() as { id: string };
    const open = await call(ada.headers, "GET", `/drive/files/${added.id}/open`);
    expect([open.statusCode, open.headers.location]).toEqual([302, "https://docs.google.com/document/d/g1/edit"]);
    expect((await db.select().from(driveOpens).where(eq(driveOpens.fileId, added.id))).map((o) => o.via)).toEqual(["google"]);
    expect((await call(ada.headers, "GET", `/drive/files/${added.id}/download`)).statusCode).toBe(400);
  });

  it("chi non vede il progetto: 404 su tutto, anche un admin che non è membro… è membro implicito, quindi lo vede", async () => {
    const p = await project();
    const ada = await person();
    const outsider = await person();
    await addMember(app, p.id, ada.id, "legacy_member");
    metas = { g1: {} };
    const added = (await call(ada.headers, "POST", `/projects/${p.id}/drive/google/files`, { googleFileId: "g1" })).json() as { id: string };
    expect((await call(outsider.headers, "GET", `/drive/files/${added.id}/open`)).statusCode).toBe(404);
    expect((await call(outsider.headers, "GET", `/projects/${p.id}/drive/google/links`)).statusCode).toBe(404);
    expect((await call({ cookie: adminCookie }, "GET", `/drive/files/${added.id}`)).statusCode).toBe(200);
  });
});
