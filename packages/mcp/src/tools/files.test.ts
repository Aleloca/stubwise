import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StubwiseApiError, type CatalogAction, type StubwiseClient } from "../client.js";
import type { StubwiseConfig } from "../config.js";
import { fileTools, mimeOf, safeFilename } from "./files.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

/**
 * `upload_file` e `download_file` (lotto 2 della parità, design
 * `docs/plans/2026-11-26-mcp-parita-design.md` § 1): un file locale verso una
 * voce multipart del catalogo, e una voce binaria salvata su disco. Il
 * binario non passa MAI come testo nella risposta del tool.
 */
const config: StubwiseConfig = { baseUrl: "https://stubwise.example.com", token: "stw_pat_x", projectSlug: null };

const UPLOAD: CatalogAction = {
  action: "attachments.upload",
  method: "POST",
  path: "/api/tickets/:ticketId/attachments",
  area: "tickets",
  summary: "Allega un file a una task.",
  effect: "write",
  access: "project:tickets.edit",
  tool: "upload_file",
};
const DOWNLOAD: CatalogAction = {
  action: "attachments.download",
  method: "GET",
  path: "/api/attachments/:attachmentId/download",
  area: "attachments",
  summary: "Scarica un allegato.",
  effect: "read",
  access: "user",
  tool: "download_file",
};
const PLAIN: CatalogAction = {
  action: "tasks.update",
  method: "PATCH",
  path: "/api/tasks/:ticketId",
  area: "tasks",
  summary: "Modifica una task.",
  effect: "write",
  access: "user",
};
const CATALOG = [UPLOAD, DOWNLOAD, PLAIN];

function tool(name: string): ToolDef {
  const t = fileTools.find((d) => d.name === name);
  if (!t) throw new Error(`manca ${name}`);
  return t;
}
function ctxWith(client: Partial<Record<keyof StubwiseClient, unknown>>): ToolContext {
  return { client: client as unknown as StubwiseClient, config };
}
const text = (r: ToolResult) => r.content[0]?.text ?? "";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stubwise-files-"));
});
afterEach(() => vi.restoreAllMocks());

describe("i tool dei file", () => {
  it("sono due: upload_file e download_file", () => {
    expect(fileTools.map((t) => t.name)).toEqual(["upload_file", "download_file"]);
  });
});

describe("upload_file", () => {
  it("legge il file locale e lo manda alla voce, col nome e il tipo dall'estensione", async () => {
    const path = join(dir, "verbale riunione.pdf");
    writeFileSync(path, Buffer.from("%PDF-1.4 ciao"));
    const uploadAction = vi.fn().mockResolvedValue({ status: 201, data: { id: "a1", filename: "verbale riunione.pdf" } });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), uploadAction });
    const r = await tool("upload_file").handler({ action: "attachments.upload", params: { ticketId: "t1" }, path }, ctx);
    expect(r.isError).toBeUndefined();
    expect(uploadAction).toHaveBeenCalledTimes(1);
    const [entry, input, file] = uploadAction.mock.calls[0]!;
    expect(entry).toBe(UPLOAD);
    expect(input).toEqual({ params: { ticketId: "t1" } });
    expect(file.name).toBe("verbale riunione.pdf");
    expect(file.type).toBe("application/pdf");
    expect(Buffer.from(file.data).toString()).toBe("%PDF-1.4 ciao");
    expect(text(r)).toContain("Caricato «verbale riunione.pdf» (13 byte)");
    expect(text(r)).toContain('"id": "a1"');
  });

  it("una voce senza `upload_file` non riceve file: lo dice, senza leggere né chiamare", async () => {
    const uploadAction = vi.fn();
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), uploadAction });
    const r = await tool("upload_file").handler({ action: "tasks.update", params: { ticketId: "t1" }, path: join(dir, "nessuno.txt") }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("non riceve file");
    expect(uploadAction).not.toHaveBeenCalled();
  });

  it("un percorso che non c'è, o una cartella: lo dice, senza chiamare", async () => {
    const uploadAction = vi.fn();
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), uploadAction });
    const missing = await tool("upload_file").handler({ action: "attachments.upload", params: { ticketId: "t1" }, path: join(dir, "manca.pdf") }, ctx);
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("non c'è");
    const folder = await tool("upload_file").handler({ action: "attachments.upload", params: { ticketId: "t1" }, path: dir }, ctx);
    expect(folder.isError).toBe(true);
    expect(text(folder)).toContain("non è un file");
    expect(uploadAction).not.toHaveBeenCalled();
  });

  it("un rifiuto del server: il suo messaggio, come errore", async () => {
    const path = join(dir, "grande.bin");
    writeFileSync(path, Buffer.alloc(10));
    const uploadAction = vi.fn().mockRejectedValue(new StubwiseApiError("HTTP 413 file_too_large: The file is too large", 413, "file_too_large"));
    const r = await tool("upload_file").handler({ action: "attachments.upload", params: { ticketId: "t1" }, path }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), uploadAction }));
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("HTTP 413 file_too_large: The file is too large");
  });
});

describe("download_file", () => {
  it("salva i byte nella cartella data, col nome del server, e risponde col percorso: mai il contenuto", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const downloadAction = vi.fn().mockResolvedValue({ status: 200, bytes, contentType: "image/png", filename: "schermata.png" });
    const ctx = ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), downloadAction });
    const r = await tool("download_file").handler({ action: "attachments.download", params: { attachmentId: "a1" }, dir }, ctx);
    expect(r.isError).toBeUndefined();
    expect(downloadAction).toHaveBeenCalledWith(DOWNLOAD, { params: { attachmentId: "a1" } });
    const saved = join(dir, "schermata.png");
    expect(readFileSync(saved)).toEqual(Buffer.from(bytes));
    expect(text(r)).toBe(`Salvato in ${saved} (6 byte, image/png).`);
  });

  it("non sovrascrive: un nome già preso diventa «nome (1)»", async () => {
    writeFileSync(join(dir, "report.csv"), "vecchio");
    const downloadAction = vi.fn().mockResolvedValue({ status: 200, bytes: new Uint8Array([65]), contentType: "text/csv", filename: "report.csv" });
    const r = await tool("download_file").handler({ action: "attachments.download", params: { attachmentId: "a1" }, dir }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), downloadAction }));
    expect(readFileSync(join(dir, "report.csv"), "utf8")).toBe("vecchio");
    expect(readFileSync(join(dir, "report (1).csv"), "utf8")).toBe("A");
    expect(text(r)).toContain("report (1).csv");
  });

  it("un nome del server con un percorso dentro resta nella cartella", async () => {
    const downloadAction = vi.fn().mockResolvedValue({ status: 200, bytes: new Uint8Array([1]), contentType: null, filename: "../../etc/passwd" });
    await tool("download_file").handler({ action: "attachments.download", params: { attachmentId: "a1" }, dir }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), downloadAction }));
    expect(readdirSync(dir)).toEqual(["passwd"]);
  });

  it("senza cartella: in una cartella temporanea propria", async () => {
    const downloadAction = vi.fn().mockResolvedValue({ status: 200, bytes: new Uint8Array([1, 2]), contentType: "application/zip", filename: "export.zip" });
    const r = await tool("download_file").handler({ action: "attachments.download", params: { attachmentId: "a1" } }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), downloadAction }));
    const m = /^Salvato in (.+) \(2 byte, application\/zip\)\.$/.exec(text(r));
    expect(m).not.toBeNull();
    expect(m![1]!.startsWith(join(tmpdir(), "stubwise-downloads"))).toBe(true);
    expect(readFileSync(m![1]!)).toEqual(Buffer.from([1, 2]));
  });

  it("una voce senza `download_file`: lo dice, senza chiamare", async () => {
    const downloadAction = vi.fn();
    const r = await tool("download_file").handler({ action: "tasks.update", params: { ticketId: "t1" }, dir }, ctxWith({ getCatalog: vi.fn().mockResolvedValue(CATALOG), downloadAction }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("non restituisce un file");
    expect(downloadAction).not.toHaveBeenCalled();
  });
});

describe("i nomi e i tipi", () => {
  it("safeFilename: solo il nome, senza separatori, caratteri di controllo né punti in testa", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\x\\nota.txt")).toBe("nota.txt");
    expect(safeFilename(".bashrc")).toBe("bashrc");
    expect(safeFilename("a\u0000b\u001fc.pdf")).toBe("abc.pdf");
    expect(safeFilename("")).toBe("file");
    expect(safeFilename(null)).toBe("file");
  });

  it("mimeOf: dall'estensione, senza maiuscole; l'ignoto è octet-stream", () => {
    expect(mimeOf("a.PDF")).toBe("application/pdf");
    expect(mimeOf("foto.jpeg")).toBe("image/jpeg");
    expect(mimeOf("senza")).toBe("application/octet-stream");
  });
});
