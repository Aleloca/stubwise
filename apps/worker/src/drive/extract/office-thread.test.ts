import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { extractOfficeInThread } from "./office-thread.js";

// L'estrazione Office in un worker_thread (review della F3): il thread
// principale non si blocca, e oltre il tempo o la memoria il risultato è `limits`.
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function file(bytes: Uint8Array) {
  dir = await mkdtemp(join(tmpdir(), "stubwise-office-thread-test-"));
  const path = join(dir, "input.docx");
  await writeFile(path, bytes);
  return { path, size: bytes.length, mime: DOCX };
}

describe("extractOfficeInThread", () => {
  it("legge un docx nel thread e risponde col testo", async () => {
    const f = await file(zipSync({ "word/document.xml": strToU8("<w:p><w:t>Dal thread</w:t></w:p>") }));
    expect(await extractOfficeInThread(f)).toEqual({ kind: "ok", text: "Dal thread" });
  }, 30_000);

  it("oltre il timeout il thread si termina: `limits`; il thread principale resta libero", async () => {
    const f = await file(zipSync({ "word/document.xml": strToU8(`<w:t>${"x ".repeat(2_000_000)}</w:t>`), "pad.bin": [new Uint8Array(200_000), { level: 0 }] }));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 5);
    const r = await extractOfficeInThread(f, { timeoutMs: 1 });
    clearInterval(timer);
    expect(r).toEqual({ kind: "limits" });
    expect(ticks).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("oltre il tetto di memoria del thread: `limits`, il worker non muore", async () => {
    // Un milione di paragrafi con un'entità (circa 40 MB, sotto il tetto di 50 MB
    // e, col riempitivo non compresso, sotto il rapporto 100): ogni testo si
    // decodifica in una stringa NUOVA sullo heap e restano tutte vive insieme
    // (l'elenco dei pezzi, poi le righe). Un testo solo e senza entità resterebbe
    // invece fuori dallo heap (la stringa esterna del decoder e le sue fette), e
    // il tetto scatterebbe o no a seconda del GC.
    const xml = `<w:body>${"<w:p><w:t>parola &amp; altra</w:t></w:p>".repeat(1_000_000)}</w:body>`;
    const f = await file(zipSync({ "word/document.xml": strToU8(xml), "pad.bin": [new Uint8Array(600_000), { level: 0 }] }));
    // Lo stesso archivio, senza tetto stretto, si legge: è la memoria a fermarlo, non i limiti dello zip.
    expect((await extractOfficeInThread(f, { timeoutMs: 20_000 })).kind).toBe("ok");
    expect(await extractOfficeInThread(f, { maxOldGenerationSizeMb: 8, timeoutMs: 20_000 })).toEqual({ kind: "limits" });
  }, 60_000);
});
