import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_ENV, prlimitArgs } from "./exec.js";
import { EXTRACT_LIMITS } from "./limits.js";
import { extractOfficeInThread, officeChildCommand, OFFICE_STDOUT_MAX_BYTES } from "./office-thread.js";

// L'estrazione Office in un PROCESSO FIGLIO `node` (dal 26 nov 2026; prima un
// worker_thread): il worker non si blocca e non muore, e oltre il tempo o la
// memoria il risultato è `limits`.
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

/** Il processo `pid` non esiste più (nemmeno come zombie): `kill(pid, 0)` lancia ESRCH. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Un «file» che il figlio non finisce MAI di leggere: una FIFO senza chi
 * scrive, su cui l'apertura resta ferma. Un file solo lento dipenderebbe dal
 * carico della macchina (a volte finiva prima del timeout).
 */
async function stuckFile() {
  dir = await mkdtemp(join(tmpdir(), "stubwise-office-thread-test-"));
  const path = join(dir, "input.docx");
  execFileSync("mkfifo", [path]);
  return { path, size: 1024, mime: DOCX };
}

describe("extractOfficeInThread", () => {
  it("legge un docx nel figlio e risponde col testo", async () => {
    const f = await file(zipSync({ "word/document.xml": strToU8("<w:p><w:t>Dal figlio</w:t></w:p>") }));
    expect(await extractOfficeInThread(f)).toEqual({ kind: "ok", text: "Dal figlio" });
  }, 30_000);

  it("oltre il timeout il figlio si uccide: `limits`, e quando la promessa si risolve il processo non c'è più", async () => {
    const f = await stuckFile();
    const pids: number[] = [];
    const started = Date.now();
    const r = await extractOfficeInThread(f, { timeoutMs: 300, onStart: (pid) => pids.push(pid) });
    expect(r).toEqual({ kind: "limits" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(pids).toHaveLength(1);
    expect(gone(pids[0]!)).toBe(true);
  }, 30_000);

  it("oltre il tetto di memoria del figlio: `limits`, il worker non muore", async () => {
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

  it("l'estrazione NON gira nel processo del worker: un OOM uccide solo lei", async () => {
    // CI del 26 nov 2026 (PR #125): su Node 22 Linux (l'immagine del worker è
    // `node:22-slim`) un worker_thread oltre `resourceLimits` dentro una
    // replace globale abbatte l'INTERO processo («Reached heap limit»), non
    // solo il thread. Il caso non dipende dalla piattaforma se l'estrazione
    // sta in un processo a sé: lo si vede dal pid, non dall'esito.
    const seen: number[] = [];
    const f = await file(zipSync({ "word/document.xml": strToU8("<w:p><w:t>pid</w:t></w:p>") }));
    expect(await extractOfficeInThread(f, { onStart: (pid) => seen.push(pid) })).toEqual({ kind: "ok", text: "pid" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(process.pid);
  }, 30_000);

  it("un figlio ucciso da fuori (SIGKILL del kernel all'OOM, senza un nostro timeout) è `limits`, non `unreadable`", async () => {
    const f = await stuckFile();
    const r = await extractOfficeInThread(f, { timeoutMs: 20_000, onStart: (pid) => process.kill(pid, "SIGKILL") });
    expect(r).toEqual({ kind: "limits" });
  }, 30_000);

  it("il figlio tronca a textMaxChars (+1, per dire «troncato») PRIMA di scrivere: un testo di caratteri di controllo resta `ok`", async () => {
    // Ogni U+0001 diventa sei byte nel JSON (`\\u0001`): senza troncare nel
    // figlio, 1,2 milioni di caratteri passerebbero il tetto di stdout.
    const n = EXTRACT_LIMITS.textMaxChars + 200_000;
    const f = await file(zipSync({ "word/document.xml": strToU8(`<w:t>${"&#1;".repeat(n)}</w:t>`), "pad.bin": [new Uint8Array(200_000), { level: 0 }] }));
    const r = await extractOfficeInThread(f, { timeoutMs: 20_000 });
    expect(r.kind).toBe("ok");
    const text = (r as { text: string }).text;
    expect(text.length).toBe(EXTRACT_LIMITS.textMaxChars + 1);
    expect(text.startsWith("\u0001\u0001")).toBe(true);
    // Il tetto di stdout regge il caso peggiore del testo troncato, e non di più.
    expect(OFFICE_STDOUT_MAX_BYTES).toBeGreaterThanOrEqual((EXTRACT_LIMITS.textMaxChars + 1) * 6);
    expect(OFFICE_STDOUT_MAX_BYTES).toBeLessThan((EXTRACT_LIMITS.textMaxChars + 1) * 6 + 1024 * 1024);
  }, 60_000);

  it("in produzione il figlio passa da prlimit (cpu e file come gli altri, SENZA --as: V8 non ci sta), con l'ambiente dei figli", () => {
    const plain = officeChildCommand({ prlimit: false, timeoutMs: 60_000, heapMb: 256, payload: "{}" });
    expect(plain.file).toBe(process.execPath);
    expect(plain.args[0]).toBe("--max-old-space-size=256");
    const limited = officeChildCommand({ prlimit: true, timeoutMs: 60_000, heapMb: 256, payload: "{}" });
    expect(limited.file).toBe("prlimit");
    expect(limited.args).toEqual([...prlimitArgs(60_000, null), process.execPath, ...plain.args]);
    expect(limited.args.some((a) => a.startsWith("--as="))).toBe(false);
    expect(limited.args.some((a) => a.startsWith("--cpu="))).toBe(true);
    expect(limited.args.some((a) => a.startsWith("--fsize="))).toBe(true);
    expect(plain.env).toBe(CHILD_ENV);
    expect(limited.env).toBe(CHILD_ENV);
  });
});
