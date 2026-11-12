import { describe, expect, it } from "vitest";
import { exportGoogleDocText, getDriveFile } from "./drive.js";
import { fakeFetch, jsonResponse } from "./test-support.js";

/**
 * Google Drive, in sola lettura (area 6, F5, task 1): i metadati di un file e
 * il testo di un Google Doc. Scope `drive.readonly` (D9 = a).
 */

const BASE = "https://www.googleapis.com/drive/v3/files";

describe("getDriveFile", () => {
  it("chiede i soli campi che servono, anche sui Drive condivisi", async () => {
    const { impl, calls } = fakeFetch([jsonResponse({ id: "d 1", name: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", trashed: false })]);
    const file = await getDriveFile({ accessToken: "at", fileId: "d 1" }, { fetchImpl: impl });
    expect(file).toEqual({ id: "d 1", name: "Notes – Revisione", mimeType: "application/vnd.google-apps.document", trashed: false });
    expect(calls[0]!.url).toBe(`${BASE}/d%201?fields=id%2Cname%2CmimeType%2Ctrashed&supportsAllDrives=true`);
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
