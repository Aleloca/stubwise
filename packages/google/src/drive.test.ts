import { describe, expect, it } from "vitest";
import { exportGoogleDocText, getDriveFile, listDriveFiles, listDriveFolders, listFolderFiles, openDriveFileStream } from "./drive.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

/**
 * Google Drive, in sola lettura (area 6, F5, task 1): i metadati di un file e
 * il testo di un Google Doc. Scope `drive.readonly` (D9 = a).
 */

const BASE = "https://www.googleapis.com/drive/v3/files";

describe("getDriveFile", () => {
  it("chiede i soli campi che servono, anche sui Drive condivisi", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: "d 1", name: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", trashed: false, createdTime: "2026-11-13T09:30:00.000Z", owners: [{ emailAddress: "Ada@Acme.com", displayName: "Ada" }] })]);
    const file = await getDriveFile({ accessToken: "at", fileId: "d 1" }, { fetchImpl: impl });
    expect(file).toEqual({ id: "d 1", name: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", trashed: false, createdTime: new Date("2026-11-13T09:30:00.000Z"), owners: ["ada@acme.com"] });
    expect(calls[0]!.url).toBe(`${BASE}/d%201?fields=id%2Cname%2CmimeType%2Ctrashed%2CcreatedTime%2Cowners%28emailAddress%29&supportsAllDrives=true`);
    expect(calls[0]!.headers.authorization).toBe("Bearer at");
  });

  it("un file che non vedo (Drive risponde 404 anche per uno non condiviso) è `file_not_found`; senza lo scope `insufficient_scope`", async () => {
    const { impl } = fakeFetch([
      jsonResponse({ error: { code: 404, message: "File not found", errors: [{ reason: "notFound" }] } }, { status: 404 }),
      jsonResponse({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, { status: 403 }),
    ]);
    await expect(getDriveFile({ accessToken: "at", fileId: "x" }, { fetchImpl: impl })).rejects.toMatchObject({ status: 404, code: "file_not_found" });
    await expect(getDriveFile({ accessToken: "at", fileId: "x" }, { fetchImpl: impl })).rejects.toMatchObject({ code: "insufficient_scope" });
  });
});

describe("exportGoogleDocText", () => {
  it("esporta il Doc in text/plain e lo taglia al tetto, dicendolo", async () => {
    const { impl, calls } = fakeFetch([new Response("Riepilogo\nPunto uno\nPunto due", { status: 200, headers: { "content-type": "text/plain" } })]);
    const out = await exportGoogleDocText({ accessToken: "at", fileId: "d1", maxChars: 12 }, { fetchImpl: impl });
    expect(calls[0]!.url).toBe(`${BASE}/d1/export?mimeType=text%2Fplain`);
    expect(out).toEqual({ text: "Riepilogo\nPu", truncated: true });
  });

  it("un Doc corto resta intero", async () => {
    const { impl } = fakeFetch([new Response("breve", { status: 200 })]);
    expect(await exportGoogleDocText({ accessToken: "at", fileId: "d1", maxChars: 100 }, { fetchImpl: impl })).toEqual({ text: "breve", truncated: false });
  });
});

describe("F5b: le liste del Drive e il contenuto", () => {
  const file = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `File ${id}`, mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-10T09:00:00.000Z", owners: [{ emailAddress: "Ada@Acme.com", displayName: "Ada" }], ...over });

  it("listDriveFiles: i miei file (niente cartelle, niente cestino), il nome cercato con gli apici protetti, anche nei Drive condivisi", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ files: [file("f1", { size: "2048" })], nextPageToken: "n2" })]);
    const page = await listDriveFiles({ accessToken: "at", query: "l'offerta" }, { fetchImpl: impl });
    expect(page).toEqual({ files: [{ id: "f1", name: "File f1", mimeType: "application/vnd.google-apps.document", modifiedAt: new Date("2026-11-10T09:00:00.000Z"), sizeBytes: 2048, owner: "ada@acme.com", ownerName: "Ada" }], nextPageToken: "n2" });
    const params = calls[0]!.params;
    expect(params.get("q")).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder' and name contains 'l\\'offerta'");
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("listDriveFolders e i file di UNA cartella (tutte le pagine, fino al tetto)", async () => {
    const folders = fakeFetch([jsonResponse({ files: [file("d1", { mimeType: "application/vnd.google-apps.folder", name: "Cliente" })] })]);
    expect((await listDriveFolders({ accessToken: "at" }, { fetchImpl: folders.impl })).files.map((f) => f.name)).toEqual(["Cliente"]);
    expect(folders.calls[0]!.params.get("q")).toBe("trashed = false and mimeType = 'application/vnd.google-apps.folder'");
    const children = fakeFetch([jsonResponse({ files: [file("a")], nextPageToken: "p2" }), jsonResponse({ files: [file("b")] })]);
    expect((await listFolderFiles({ accessToken: "at", folderId: "d 1", max: 10 }, { fetchImpl: children.impl })).map((f) => f.id)).toEqual(["a", "b"]);
    expect(children.calls[0]!.params.get("q")).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder' and 'd 1' in parents");
  });

  it("openDriveFileStream: un Doc nativo si esporta (text/plain, un Foglio text/csv), un altro file si scarica", async () => {
    const { impl, calls } = fakeFetch([new Response("testo", { status: 200 }), new Response("a,b", { status: 200 }), new Response("%PDF", { status: 200 })]);
    const doc = await openDriveFileStream({ accessToken: "at", fileId: "d1", mimeType: "application/vnd.google-apps.document" }, { fetchImpl: impl });
    expect([doc.mime, await new Response(doc.body).text()]).toEqual(["text/plain", "testo"]);
    expect(calls[0]!.url).toBe(`${BASE}/d1/export?mimeType=text%2Fplain`);
    const sheet = await openDriveFileStream({ accessToken: "at", fileId: "s1", mimeType: "application/vnd.google-apps.spreadsheet" }, { fetchImpl: impl });
    expect(sheet.mime).toBe("text/csv");
    const pdf = await openDriveFileStream({ accessToken: "at", fileId: "p1", mimeType: "application/pdf" }, { fetchImpl: impl });
    expect(pdf.mime).toBe("application/pdf");
    expect(calls[2]!.url).toBe(`${BASE}/p1?alt=media&supportsAllDrives=true`);
  });

  it("un file non più visibile è file_not_found anche nello stream", async () => {
    const { impl } = fakeFetch([jsonResponse({ error: { code: 404, message: "nf", errors: [{ reason: "notFound" }] } }, { status: 404 })]);
    await expect(openDriveFileStream({ accessToken: "at", fileId: "x", mimeType: "application/pdf" }, { fetchImpl: impl })).rejects.toMatchObject({ code: "file_not_found" });
  });
});
