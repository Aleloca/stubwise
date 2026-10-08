// apps/worker/src/agent/streaming-cli.test.ts
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliRunner } from "./claude-cli.js";
import { AgentTimeoutError, type AgentRunner } from "./runner.js";
import { INTERACTIVE_SEGMENTS } from "@stubwise/shared";
import {
  DELIVERABLE_REMINDER,
  SEGMENT_DELIVERABLE,
  StreamingClaudeRunner,
  type LiveProcessHandle,
  type SessionHooks,
} from "./streaming-cli.js";
import { parseStreamLine, type SessionEventDraft } from "../sessions/stream-parser.js";

const here = dirname(fileURLToPath(import.meta.url));

// Finto CLI stream-json: legge stdin riga per riga. Un messaggio utente
// produce init (solo la prima volta) + assistant + result. Un messaggio che
// contiene SLOW risponde dopo 300 ms (per iniettare a metà turno); un
// control_request interrupt chiude il turno in corso con un result di errore.
// Ogni result porta un costo CUMULATIVO, come il CLI vero.
const FAKE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let cost = 0, inited = false, pending = null, absorbed = [], failing = false;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
function finish(text) {
  cost += 0.01;
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: cost, session_id: "sess-1", modelUsage: { m: { inputTokens: 1, outputTokens: 1, costUSD: cost } } });
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    if (pending) { clearTimeout(pending.t); pending = null;
      cost += 0.01;
      out({ type: "control_response", response: { request_id: msg.request_id, subtype: "success" } });
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "", total_cost_usd: cost, session_id: "sess-1" }); }
    return;
  }
  const text = msg.message.content;
  if (!inited) { inited = true; out({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] }); }
  if (pending) { absorbed.push(text); return; }
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "…" + (text.includes("SECRET") ? " value=hunter2-secret" : "") } } });
  if (text.includes("SLOW")) {
    pending = { t: setTimeout(() => { const extra = absorbed.join("+"); absorbed = []; pending = null; finish("slow done" + (extra ? " with " + extra : "")); }, 300) };
  } else if (text.includes("FAIL")) {
    cost += 0.01;
    process.stderr.write("boom on stderr\\n");
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "failed text", total_cost_usd: cost, session_id: "sess-1" });
    failing = true; // esce con 3 alla chiusura di stdin, dopo aver scritto tutto
  } else if (text.includes("HANG")) {
    // non risponde mai: serve al test del timeout
  } else if (text.includes("ENV")) {
    finish("env: " + process.env.ANTHROPIC_API_KEY + " " + process.env.EXTRA_TOKEN);
  } else finish("echo: " + text + (text.includes("SECRET") ? " value=hunter2-secret" : ""));
});
rl.on("close", () => process.exit(failing ? 3 : 0));
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fakeClaude(): Promise<{ bin: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "stw-stream-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "claude");
  await writeFile(bin, FAKE, "utf8");
  await chmod(bin, 0o755);
  return { bin, cwd: root };
}

function recordingHooks() {
  const events: SessionEventDraft[] = [];
  const partials: string[] = [];
  const handles = new Map<string, LiveProcessHandle>();
  let ended = 0;
  let starts = 0;
  let caps: string[] = [];
  const endInfos: Array<{ exitCode: number | null; timedOut: boolean }> = [];
  const hooks: SessionHooks = {
    openSegment: () => ({
      onStart: (c) => { caps = c; starts++; },
      onEvents: (e) => { events.push(...e); },
      onPartial: (p) => { partials.push(p); },
      onEnd: async (info) => { ended++; endInfos.push(info); },
    }),
    register: (id, h) => {
      handles.set(id, h);
      return () => handles.delete(id);
    },
  };
  return {
    hooks,
    events,
    partials,
    handles,
    endInfos,
    get ended() { return ended; },
    get starts() { return starts; },
    get caps() { return caps; },
  };
}

const base = { maxTurns: 5, timeoutMs: 10_000 };
const session = { sessionId: "s1", label: "execute" as const };
const META = { inputId: "7f1c2a1e-0000-4000-8000-0000000000aa", authorUserId: "7f1c2a1e-0000-4000-8000-0000000000bb" };

describe("StreamingClaudeRunner.recordsSessions", () => {
  it("registra le sessioni solo con gli hook del relay; il runner storico mai", () => {
    const hooks: SessionHooks = {
      openSegment: () => ({ onStart: () => {}, onEvents: () => {}, onPartial: () => {}, onEnd: async () => {} }),
      register: () => () => {},
    };
    expect(new StreamingClaudeRunner({ hooks }).recordsSessions).toBe(true);
    expect(new StreamingClaudeRunner().recordsSessions).toBe(false);
    const classic: AgentRunner = new ClaudeCliRunner();
    expect(classic.recordsSessions).toBeUndefined();
  });
});

describe("StreamingClaudeRunner", () => {
  it("un run semplice esce da solo dopo il grace e restituisce output, usage, session id", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const result = await runner.run({ ...base, cwd, prompt: "hello", session });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("echo: hello");
    expect(result.sessionId).toBe("sess-1");
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.01);
    expect(rec.events.map((e) => e.type)).toEqual(["assistant_text", "turn_end"]);
    expect(rec.partials.length).toBeGreaterThan(0);
    expect(rec.caps).toContain("interrupt_receipt_v1");
    expect(rec.ended).toBe(1);
    expect(rec.handles.size).toBe(0); // deregistrato a fine run
  });

  it("un messaggio consegnato a metà turno viene assorbito e il run finisce (nessun hang)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.handles.get("s1")!.deliver("BANANA", false, META)).toBe(true);
    const result = await run;
    // Il finto CLI fa l'eco di ciò che LEGGE da stdin: il promemoria del
    // deliverable c'è; l'evento `input` (e quindi il commento) ha il testo nudo.
    expect(result.output).toBe(`slow done with BANANA\n\n${DELIVERABLE_REMINDER}`);
    const input = rec.events.find((e) => e.type === "input")!;
    expect(input.data).toEqual({ text: "BANANA", interrupt: false, inputId: META.inputId, authorUserId: META.authorUserId });
    expect(result.inputsDelivered).toBe(1);
  });

  it("interruzione + messaggio: l'esito è l'ULTIMO result, exit 0, costo cumulativo", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.handles.get("s1")!.deliver("cambia strada", true, META)).toBe(true);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`echo: cambia strada\n\n${DELIVERABLE_REMINDER}`);
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.02);
    expect(rec.events.find((e) => e.type === "input")!.data["text"]).toBe("cambia strada");
  });

  it("dopo la chiusura di stdin deliver restituisce false (→ undelivered)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    let handle: LiveProcessHandle | undefined;
    const hooks: SessionHooks = {
      ...rec.hooks,
      register: (id, h) => {
        handle = h;
        return () => undefined;
      },
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 20 });
    await runner.run({ ...base, cwd, prompt: "hi", session });
    expect(handle!.deliver("troppo tardi", false, META)).toBe(false);
  });

  it("ogni segmento interattivo ha il suo deliverable classificato (output o file), e solo quelli", () => {
    expect(new Set(Object.keys(SEGMENT_DELIVERABLE))).toEqual(new Set(INTERACTIVE_SEGMENTS));
    expect(SEGMENT_DELIVERABLE.plan).toBe("output");
    expect(SEGMENT_DELIVERABLE.plan_resume).toBe("output");
    expect(SEGMENT_DELIVERABLE.execute).toBe("files");
  });

  it("deliverable nell'output (plan): dopo il PRIMO result nessun intervento entra, nemmeno nella grazia, e l'output resta il piano", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    // Grazia lunga: l'intervento arriva DENTRO la finestra, a processo vivo.
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "il piano", session: { sessionId: "s1", label: "plan" } });
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rec.handles.get("s1")!.deliver("rispondimi ok", false, META)).toBe(false);
    const result = await run;
    expect(result.output).toBe("echo: il piano");
    expect(result.inputsDelivered).toBeUndefined();
    expect(rec.events.some((e) => e.type === "input")).toBe(false);
  });

  it("deliverable nei file (execute): nella grazia l'intervento entra ancora e apre un turno", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "primo", session });
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rec.handles.get("s1")!.deliver("secondo", false, META)).toBe(true);
    const result = await run;
    expect(result.output).toBe(`echo: secondo\n\n${DELIVERABLE_REMINDER}`);
    expect(result.inputsDelivered).toBe(1);
  });

  it("oscura i segreti negli eventi e nei parziali", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20 });
    await runner.run({ ...base, cwd, prompt: "SECRET", session: { ...session, secrets: ["hunter2-secret"] } });
    expect(JSON.stringify(rec.events)).not.toContain("hunter2-secret");
    expect(JSON.stringify(rec.events)).toContain("•••");
    // Il parziale portava il segreto: deve arrivare al sink già oscurato.
    expect(rec.partials.join("")).toContain("•••");
    expect(rec.partials.join("")).not.toContain("hunter2-secret");
  });

  it("oscura anche la chiave del provider e i valori di extraEnv, senza che il chiamante li passi", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({
      claudePath: bin,
      hooks: rec.hooks,
      resultGraceMs: 20,
      extraEnv: { EXTRA_TOKEN: "extra-token-value" },
    });
    await runner.run({
      ...base,
      cwd,
      prompt: "ENV",
      session,
      provider: { id: "p1", kind: "api_key", secret: "sk-ant-provider-secret" },
    });
    const dump = JSON.stringify(rec.events);
    expect(dump).not.toContain("sk-ant-provider-secret");
    expect(dump).not.toContain("extra-token-value");
    expect(dump).toContain("•••");
  });

  it("exit non-zero: output = testo dell'ultimo result + coda dello stderr, MAI lo stream-json", async () => {
    const { bin, cwd } = await fakeClaude();
    const runner = new StreamingClaudeRunner({ claudePath: bin, resultGraceMs: 20 });
    const result = await runner.run({ ...base, cwd, prompt: "FAIL", session });
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("failed text");
    expect(result.output).toContain("boom on stderr");
    expect(result.output).not.toContain('"type":"result"');
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.01);
  });

  it("un segmento NON interattivo chiude stdin subito dopo il result (niente grazia)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    // Grazia enorme: se venisse applicata, il test andrebbe in timeout.
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 60_000 });
    const started = Date.now();
    const result = await runner.run({ ...base, cwd, prompt: "hello", session: { sessionId: "s2", label: "triage" } });
    expect(result.output).toBe("echo: hello");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rec.handles.size).toBe(0); // mai registrato: non interattivo
  });

  it("un sink che lancia non fa fallire il run (fail-open)", async () => {
    const { bin, cwd } = await fakeClaude();
    const hooks: SessionHooks = {
      openSegment: () => ({
        onStart: () => { throw new Error("db down"); },
        onEvents: () => { throw new Error("db down"); },
        onPartial: () => { throw new Error("db down"); },
        onEnd: async () => { throw new Error("db down"); },
      }),
      register: () => () => undefined,
    };
    const logs: string[] = [];
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 20, log: (m) => logs.push(m) });
    const result = await runner.run({ ...base, cwd, prompt: "hello", session });
    expect(result.output).toBe("echo: hello");
    // Mai silenzioso: ogni guasto del sink lascia una riga di log.
    expect(logs.some((m) => m.includes("onEnd fallito"))).toBe(true);
    expect(logs.some((m) => m.includes("onEvents fallito"))).toBe(true);
  });

  it("senza session funziona uguale e non registra niente", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20 });
    const result = await runner.run({ ...base, cwd, prompt: "hello" });
    expect(result.output).toBe("echo: hello");
    expect(rec.events).toHaveLength(0);
  });

  it("argv in streaming: i flag di formato e nessun prompt in argv", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-argv-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    // Stampa argv come result e chiude.
    await writeFile(
      bin,
      `#!/usr/bin/env node
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  process.stdout.write(JSON.stringify({ type: "result", result: process.argv.slice(2).join(" ") }) + "\\n");
});`,
    );
    await chmod(bin, 0o755);
    const runner = new StreamingClaudeRunner({ claudePath: bin, resultGraceMs: 20 });
    const { output } = await runner.run({ ...base, cwd: root, prompt: "PROMPT-SEGRETO" });
    expect(output).toContain("--input-format stream-json --output-format stream-json --verbose --include-partial-messages");
    expect(output).not.toContain("PROMPT-SEGRETO");
  });
  it("init ripetuto a ogni turno (come il CLI vero): onStart UNA volta per processo", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-init-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    // Come la 2.1.287: ogni messaggio utente apre un turno con un system/init.
    await writeFile(
      bin,
      `#!/usr/bin/env node
let cost = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content;
  cost += 0.01;
  out({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] });
  out({ type: "assistant", message: { content: [{ type: "text", text: "re: " + text }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "re: " + text, total_cost_usd: cost, session_id: "sess-1" });
}).on("close", () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);
    const rec = recordingHooks();
    let delivered = false;
    const hooks: SessionHooks = {
      openSegment: (...a) => {
        const sink = rec.hooks.openSegment(...a);
        return {
          ...sink,
          onEvents: (e) => {
            sink.onEvents(e);
            // Secondo turno: consegnato appena il primo finisce, dentro la grazia.
            if (!delivered && e.some((x) => x.type === "turn_end")) {
              delivered = true;
              expect(rec.handles.get("s1")!.deliver("secondo", false, META)).toBe(true);
            }
          },
        };
      },
      register: rec.hooks.register,
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 500 });
    const result = await runner.run({ ...base, cwd: root, prompt: "primo", session });
    expect(result.output).toBe(`re: secondo\n\n${DELIVERABLE_REMINDER}`);
    expect(rec.events.filter((e) => e.type === "turn_end")).toHaveLength(2);
    expect(rec.starts).toBe(1);
    expect(rec.caps).toEqual(["interrupt_receipt_v1"]);
    expect(rec.ended).toBe(1);
  });

  it("traccia VERA interrupt-then-message (2.1.287): l'esito è il result di successo, non l'interruzione", async () => {
    const tracePath = join(here, "..", "sessions", "fixtures", "interrupt-then-message.jsonl");
    const raw = readFileSync(tracePath, "utf8");
    const resultsInTrace = raw
      .split("\n")
      .map(parseStreamLine)
      .filter((e): e is NonNullable<typeof e> => e !== null && e.type === "result");
    // Se la traccia smettesse di contenere l'interruzione, questo test non
    // proverebbe più niente: lo si fissa qui.
    expect(resultsInTrace.map((r) => r["subtype"])).toEqual(["error_during_execution", "success"]);
    const last = resultsInTrace[1]!;

    const root = await mkdtemp(join(tmpdir(), "stw-replay-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    // Rigioca la traccia vera sullo stdout al primo messaggio, esce a stdin chiuso.
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
require("node:readline").createInterface({ input: process.stdin })
  .once("line", () => process.stdout.write(fs.readFileSync(process.env.TRACE_FILE, "utf8")))
  .on("close", () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({
      claudePath: bin,
      hooks: rec.hooks,
      resultGraceMs: 50,
      extraEnv: { TRACE_FILE: tracePath },
    });
    const result = await runner.run({ ...base, cwd: root, prompt: "go", session });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(last["result"]);
    expect(result.usage?.totalCostUsd).toBe(last["total_cost_usd"]);
    expect(result.sessionId).toBe(last["session_id"]);
    const turnEnds = rec.events.filter((e) => e.type === "turn_end");
    expect(turnEnds.map((e) => e.data["subtype"])).toEqual(["error_during_execution", "success"]);
    expect(rec.starts).toBe(1); // due system/init nella traccia
    expect(rec.ended).toBe(1);
  });

  it("timeout: AgentTimeoutError e onEnd con timedOut", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20 });
    await expect(runner.run({ ...base, timeoutMs: 400, cwd, prompt: "HANG", session })).rejects.toBeInstanceOf(
      AgentTimeoutError,
    );
    expect(rec.endInfos).toEqual([{ exitCode: null, timedOut: true }]);
    expect(rec.handles.size).toBe(0);
  });

  it("binario inesistente: AgentRunError, nessun handle lasciato registrato", async () => {
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: "/nonexistent/claude-xyz", hooks: rec.hooks });
    await expect(
      runner.run({ ...base, cwd: tmpdir(), prompt: "hi", session }),
    ).rejects.toThrow(/Impossibile eseguire/);
    expect(rec.handles.size).toBe(0);
  });
  it("una riga fuori turno dopo l'ultimo result non annulla la grazia: il run finisce, non va in timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "stw-stray-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = join(root, "claude");
    // result, poi (un attimo dopo, a grazia già armata) una riga system di
    // stato; poi resta vivo finché stdin non si chiude.
    await writeFile(
      bin,
      `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  out({ type: "system", subtype: "init", capabilities: [] });
  out({ type: "assistant", message: { content: [{ type: "text", text: "fatto" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "fatto", total_cost_usd: 0.01, session_id: "sess-1" });
  setTimeout(() => out({ type: "system", subtype: "status", status: null }), 30);
}).on("close", () => process.exit(0));
`,
    );
    await chmod(bin, 0o755);
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 150 });
    const started = Date.now();
    const result = await runner.run({ ...base, timeoutMs: 4_000, cwd: root, prompt: "go", session });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fatto");
    expect(result.usage?.totalCostUsd).toBeCloseTo(0.01);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(rec.endInfos).toEqual([{ exitCode: 0, timedOut: false }]);
  });
});
