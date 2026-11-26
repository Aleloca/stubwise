import { describe, expect, it } from "vitest";
import { createExec } from "./exec.js";
import { EXTRACT_LIMITS } from "./limits.js";

// Il lanciatore dei processi figli (area 5, fetta 3): mai una shell, il
// figlio ucciso con SIGKILL al timeout, un binario assente è `missing` (un
// risultato, non un'eccezione), un crash è `failed`.
const exec = createExec({ prlimit: false });

describe("createExec", () => {
  it("un comando che risponde: stdout come Buffer", async () => {
    const r = await exec(process.execPath, ["-e", "process.stdout.write('ciao')"], { cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1024 });
    expect(r).toEqual({ ok: true, stdout: Buffer.from("ciao") });
  });

  it("niente shell: un argomento con metacaratteri arriva tale e quale", async () => {
    const r = await exec(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "$(echo boom); rm -rf /tmp/x"], { cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1024 });
    expect(r).toEqual({ ok: true, stdout: Buffer.from("$(echo boom); rm -rf /tmp/x") });
  });

  it("un figlio che non finisce è `timeout`, e non sopravvive", async () => {
    const started = Date.now();
    // Ignora SIGTERM: solo SIGKILL lo ferma.
    const r = await exec(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 300, maxBuffer: 1024 });
    expect(r).toMatchObject({ ok: false, kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("un figlio che esce con un segnale o un codice diverso da zero è `failed`", async () => {
    expect(await exec(process.execPath, ["-e", "process.kill(process.pid, 'SIGSEGV')"], { cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1024 })).toMatchObject({ ok: false, kind: "failed" });
    expect(await exec(process.execPath, ["-e", "process.exit(3)"], { cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1024 })).toMatchObject({ ok: false, kind: "failed" });
  });

  it("un binario che non c'è è `missing`", async () => {
    expect(await exec("stubwise-non-esiste-davvero", [], { cwd: process.cwd(), timeoutMs: 1_000, maxBuffer: 1024 })).toMatchObject({ ok: false, kind: "missing" });
  });

  it("uno stdout oltre il tetto è `output_limit`", async () => {
    const r = await exec(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1000 });
    expect(r).toMatchObject({ ok: false, kind: "output_limit" });
  });

  it("con prlimit il comando gira DIETRO prlimit, coi tetti di memoria e di cpu", async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const wrapped = createExec({ prlimit: true, memoryBytes: 1024 ** 3, which: async () => true, spawn: (file, args) => (calls.push({ file, args }), Promise.resolve({ ok: true as const, stdout: Buffer.alloc(0) })) });
    await wrapped("tesseract", ["a.png", "stdout"], { cwd: "/tmp", timeoutMs: 60_000, maxBuffer: 10 });
    // Anche il disco (review della F3): un file scritto dal figlio non passa il tetto.
    expect(calls[0]).toEqual({ file: "prlimit", args: [`--as=${1024 ** 3}`, "--cpu=65", `--fsize=${EXTRACT_LIMITS.childFileBytes}`, "--", "tesseract", "a.png", "stdout"] });
  });
});
