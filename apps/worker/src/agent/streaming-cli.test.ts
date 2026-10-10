// apps/worker/src/agent/streaming-cli.test.ts
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliRunner } from "./claude-cli.js";
import { AgentRunCancelledError, AgentTimeoutError, type AgentRunner } from "./runner.js";
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
// control_request interrupt chiude il turno in corso con un result di errore
// (a turno fermo risponde e basta). Ogni result porta un costo CUMULATIVO,
// come il CLI vero. Con --replay-user-messages fa l'ECO di ogni messaggio
// quando lo PRENDE (all'inizio del turno o all'assorbimento), con l'uuid della
// riga se c'è, altrimenti uno suo — come la 2.1.287 (cli-replay A/B/C). Un
// messaggio con NOECHO, assorbito a metà turno, sparisce senza eco.
const FAKE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
let cost = 0, inited = false, pending = null, absorbed = [], failing = false;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const replay = process.argv.includes("--replay-user-messages");
const echo = (msg) => { if (replay) out({ type: "user", message: { role: "user", content: msg.message.content }, uuid: msg.uuid || "cli-" + Math.random(), isReplay: true }); };
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
    else out({ type: "control_response", response: { request_id: msg.request_id, subtype: "success" } });
    return;
  }
  const text = msg.message.content;
  if (!inited) { inited = true; out({ type: "system", subtype: "init", capabilities: ["interrupt_receipt_v1"] }); }
  if (pending) { if (!text.includes("NOECHO")) { echo(msg); absorbed.push(text); } return; }
  echo(msg);
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
  let inputsClosed = 0;
  let caps: string[] = [];
  const endInfos: Array<{ exitCode: number | null; timedOut: boolean }> = [];
  const notEchoed: string[][] = [];
  const hooks: SessionHooks = {
    openSegment: () => ({
      onStart: (c) => { caps = c; starts++; },
      onEvents: (e) => { events.push(...e); },
      onPartial: (p) => { partials.push(p); },
      onEnd: async (info) => { ended++; endInfos.push(info); },
      onInputsClosed: () => { inputsClosed++; },
    }),
    register: (id, h) => {
      handles.set(id, h);
      return () => handles.delete(id);
    },
    inputsNotEchoed: async (_sessionId, ids) => {
      notEchoed.push(ids);
    },
  };
  return {
    hooks,
    notEchoed,
    events,
    partials,
    handles,
    endInfos,
    get ended() { return ended; },
    get starts() { return starts; },
    get inputsClosed() { return inputsClosed; },
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

  it("plan: dopo un interrupt (result error_during_execution) il turno rediretto accetta ancora un secondo intervento", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session: { sessionId: "s1", label: "plan" } });
    await new Promise((r) => setTimeout(r, 100));
    // Il testo ha SLOW: il turno rediretto resta aperto 300 ms.
    expect(rec.handles.get("s1")!.deliver("SLOW cambia strada", true, META)).toBe(true);
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.handles.get("s1")!.deliver("e anche questo", false, { ...META, inputId: "in-2" })).toBe(true);
    const result = await run;
    expect(result.inputsDelivered).toBe(2);
    expect(rec.events.filter((e) => e.type === "input")).toHaveLength(2);
  });

  it("plan: al primo result riuscito il sink sa SUBITO che gli interventi sono chiusi (una volta sola, prima della fine)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "il piano", session: { sessionId: "s1", label: "plan" } });
    for (let i = 0; i < 200 && rec.inputsClosed === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    // Nella grazia: il processo è ancora vivo, il segmento non è finito.
    expect(rec.inputsClosed).toBe(1);
    expect(rec.ended).toBe(0);
    expect(rec.handles.get("s1")!.deliver("tardi", false, META)).toBe(false);
    await run;
    expect(rec.inputsClosed).toBe(1);
  });

  it("plan: un result da interrupt NON chiude gli interventi (il segnale arriva solo col result riuscito)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 400 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session: { sessionId: "s1", label: "plan" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(rec.handles.get("s1")!.deliver("SLOW cambia strada", true, META)).toBe(true);
    // Il result di errore dell'interrupt è già passato; il turno rediretto è in corso.
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(rec.inputsClosed).toBe(0);
    await run;
    expect(rec.inputsClosed).toBe(1);
  });

  it("deliverable nei file (execute): alla chiusura di stdin (fine grazia) il sink riceve il segnale, prima della fine del segmento", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    let endedAtSignal: number | null = null;
    const hooks: SessionHooks = {
      ...rec.hooks,
      openSegment: (...a) => {
        const sink = rec.hooks.openSegment(...a);
        return {
          ...sink,
          onInputsClosed: () => {
            endedAtSignal = rec.ended;
            sink.onInputsClosed?.();
          },
        };
      },
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 50 });
    await runner.run({ ...base, cwd, prompt: "primo", session });
    expect(rec.inputsClosed).toBe(1);
    expect(endedAtSignal).toBe(0);
  });

  it("deliverable nei file (execute): nella grazia il segnale NON parte; un intervento riapre il turno e il segnale arriva una volta sola alla chiusura", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    // Linea del tempo delle chiamate al sink: il segnale deve stare DOPO la
    // fine del turno RIAPERTO, e a una grazia intera di distanza da lei (cioè
    // alla chiusura di stdin, non all'armo della grazia né al primo turno).
    const GRACE = 300;
    const timeline: Array<{ what: string; at: number }> = [];
    const hooks: SessionHooks = {
      ...rec.hooks,
      openSegment: (...a) => {
        const sink = rec.hooks.openSegment(...a);
        return {
          ...sink,
          onEvents: (e) => {
            for (const ev of e) if (ev.type === "turn_end") timeline.push({ what: "turn_end", at: Date.now() });
            sink.onEvents(e);
          },
          onInputsClosed: () => {
            timeline.push({ what: "closed", at: Date.now() });
            sink.onInputsClosed?.();
          },
        };
      },
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: GRACE });
    const run = runner.run({ ...base, cwd, prompt: "primo", session });
    for (let i = 0; i < 200 && !rec.events.some((e) => e.type === "turn_end"); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rec.inputsClosed).toBe(0);
    expect(rec.handles.get("s1")!.deliver("secondo", false, META)).toBe(true);
    await run;
    expect(rec.inputsClosed).toBe(1);
    expect(timeline.map((x) => x.what)).toEqual(["turn_end", "turn_end", "closed"]);
    const reopenedEnd = timeline[1]!.at;
    const closed = timeline[2]!.at;
    // Tolleranza sul timer, mai sotto la grazia di più di qualche ms.
    expect(closed - reopenedEnd).toBeGreaterThanOrEqual(GRACE - 20);
  });

  it("deliverable nell'output (plan): il segnale del result e la chiusura di stdin non si sommano (una volta sola)", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    await runner.run({ ...base, cwd, prompt: "il piano", session: { sessionId: "s1", label: "plan" } });
    expect(rec.inputsClosed).toBe(1);
  });

  it("segmento NON interattivo (triage): nessun segnale", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    await runner.run({ ...base, cwd, prompt: "hello", session: { sessionId: "s2", label: "triage" } });
    expect(rec.inputsClosed).toBe(0);
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
    // L'eco dei messaggi: è ciò che dice QUANDO il CLI ha preso un intervento.
    expect(output.split(" ")).toContain("--replay-user-messages");
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

const META2 = { inputId: "7f1c2a1e-0000-4000-8000-0000000000cc", authorUserId: META.authorUserId };
const STOP = { inputId: "7f1c2a1e-0000-4000-8000-0000000000dd", authorUserId: "7f1c2a1e-0000-4000-8000-0000000000ee" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Aspetta che il finto CLI abbia APERTO il turno SLOW (il suo primo parziale):
 * con la macchina carica l'avvio di node supera i 100 ms, e uno «Ferma»
 * arrivato prima troverebbe il CLI fermo (nessun result da interrupt).
 */
async function turnOpen(rec: { partials: string[] }, before = 0): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (rec.partials.length <= before) {
    if (Date.now() > deadline) throw new Error("turno mai aperto");
    await sleep(10);
  }
}

describe("StreamingClaudeRunner — coda all'eco", () => {
  it("il prompt iniziale fa eco con un uuid non nostro: nessun evento input, nessuno spazzato", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    await runner.run({ ...base, cwd, prompt: "hello", session });
    expect(rec.events.filter((e) => e.type === "input")).toHaveLength(0);
    expect(rec.notEchoed).toEqual([]);
  });

  it("l'evento input nasce all'ECO (uuid = id dell'intervento), non alla scrittura su stdin", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await turnOpen(rec);
    // Assorbito senza eco: scritto su stdin, ma il CLI non l'ha mai preso.
    expect(rec.handles.get("s1")!.deliver("NOECHO perso", false, META2)).toBe(true);
    expect(rec.handles.get("s1")!.deliver("BANANA", false, META)).toBe(true);
    const result = await run;
    const inputs = rec.events.filter((e) => e.type === "input");
    expect(inputs.map((e) => e.data["inputId"])).toEqual([META.inputId]);
    // Ciò che non ha mai avuto l'eco, a fine segmento, torna al relay.
    expect(rec.notEchoed).toEqual([[META2.inputId]]);
    expect(result.output).toBe(`slow done with BANANA\n\n${DELIVERABLE_REMINDER}`);
  });
});

describe("StreamingClaudeRunner — coda all'eco, fail-open", () => {
  it("un inputsNotEchoed che lancia (anche in modo sincrono) non fa fallire il run", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const logs: string[] = [];
    const hooks: SessionHooks = {
      ...rec.hooks,
      inputsNotEchoed: () => {
        throw new Error("db giù");
      },
    };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 50, log: (m) => logs.push(m) });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await turnOpen(rec);
    rec.handles.get("s1")!.deliver("NOECHO perso", false, META2);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    expect(logs.some((l) => l.includes("db giù"))).toBe(true);
    expect(rec.handles.size).toBe(0);
  });
});

describe("StreamingClaudeRunner — «Ferma» senza testo e pausa", () => {
  it("Ferma senza testo: interrupt e niente messaggio, la grazia NON chiude, un messaggio fa ripartire il run", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50 });
    let settled = false;
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session }).finally(() => {
      settled = true;
    });
    await turnOpen(rec);
    expect(rec.handles.get("s1")!.deliver("", true, STOP)).toBe(true);
    // Il turno interrotto finisce col suo result di errore: in pausa la grazia
    // non lo chiude, il processo resta vivo.
    await sleep(400);
    expect(settled).toBe(false);
    expect(rec.events.filter((e) => e.type === "turn_end").map((e) => e.data["subtype"])).toEqual([
      "error_during_execution",
    ]);
    expect(rec.handles.get("s1")!.deliver("riparti da qui", false, META)).toBe(true);
    const result = await run;
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`echo: riparti da qui\n\n${DELIVERABLE_REMINDER}`);
    // Lo «Ferma» non ha eco per costruzione: nessun evento input, e non è MAI
    // fra quelli da spazzare (resta `delivered`, è ciò che dice «in pausa»).
    expect(rec.events.filter((e) => e.type === "input").map((e) => e.data["inputId"])).toEqual([META.inputId]);
    expect(rec.notEchoed.flat()).not.toContain(STOP.inputId);
    expect(result.inputsDelivered).toBe(1);
  });

  it("pausa scaduta: stdin chiuso, AgentRunCancelledError con chi l'ha fermato, segmento chiuso", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50, pauseBudgetMs: 300 });
    const run = runner.run({ ...base, cwd, prompt: "SLOW", session });
    await turnOpen(rec);
    expect(rec.handles.get("s1")!.deliver("", true, STOP)).toBe(true);
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunCancelledError);
    expect((error as AgentRunCancelledError).stoppedByUserId).toBe(STOP.authorUserId);
    expect((error as AgentRunCancelledError).pauseBudgetMs).toBe(300);
    expect(rec.ended).toBe(1);
    expect(rec.handles.size).toBe(0);
    expect(rec.notEchoed.flat()).not.toContain(STOP.inputId);
  });

  it("il tetto è TOTALE per chiave: la seconda pausa dello stesso lavoro scade a ciò che resta", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50, pauseBudgetMs: 1_000 });
    const keyed = { ...session, pauseKey: "ai_job:uno" };
    const first = runner.run({ ...base, cwd, prompt: "SLOW", session: keyed });
    await turnOpen(rec);
    rec.handles.get("s1")!.deliver("", true, STOP);
    await sleep(700);
    rec.handles.get("s1")!.deliver("avanti", false, META);
    await first;
    const p1 = rec.partials.length;
    const second = runner.run({ ...base, cwd, prompt: "SLOW", session: keyed });
    await turnOpen(rec, p1);
    const pausedAt = Date.now();
    rec.handles.get("s1")!.deliver("", true, STOP);
    await expect(second).rejects.toBeInstanceOf(AgentRunCancelledError);
    // ~300 ms rimasti, non i 1000 di un budget nuovo.
    expect(Date.now() - pausedAt).toBeLessThan(800);
    // Un'altra chiave ha il suo budget intero.
    const p2 = rec.partials.length;
    const other = runner.run({ ...base, cwd, prompt: "SLOW", session: { ...session, pauseKey: "ai_job:due" } });
    await turnOpen(rec, p2);
    rec.handles.get("s1")!.deliver("", true, STOP);
    await sleep(600);
    rec.handles.get("s1")!.deliver("ok", false, META);
    await expect(other).resolves.toMatchObject({ exitCode: 0 });
  });

  it("la pausa non consuma il timeout dell'agente: il run riparte oltre il timeout e finisce", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 50, pauseBudgetMs: 5_000 });
    const run = runner.run({ ...base, timeoutMs: 800, cwd, prompt: "SLOW", session });
    await turnOpen(rec);
    rec.handles.get("s1")!.deliver("", true, STOP);
    await sleep(1_200);
    rec.handles.get("s1")!.deliver("dopo la pausa", false, META);
    const result = await run;
    expect(result.output).toBe(`echo: dopo la pausa\n\n${DELIVERABLE_REMINDER}`);
    expect(rec.endInfos).toEqual([{ exitCode: 0, timedOut: false }]);
  });

  it("fuori dalla pausa il timeout resta quello di sempre", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks: rec.hooks, resultGraceMs: 20, pauseBudgetMs: 60_000 });
    const started = Date.now();
    await expect(runner.run({ ...base, timeoutMs: 400, cwd, prompt: "HANG", session })).rejects.toBeInstanceOf(
      AgentTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rec.endInfos).toEqual([{ exitCode: null, timedOut: true }]);
  });

  it("Ferma a stdin chiuso: false (→ undelivered), come ogni intervento", async () => {
    const { bin, cwd } = await fakeClaude();
    const rec = recordingHooks();
    let handle: LiveProcessHandle | undefined;
    const hooks: SessionHooks = { ...rec.hooks, register: (_id, h) => ((handle = h), () => undefined) };
    const runner = new StreamingClaudeRunner({ claudePath: bin, hooks, resultGraceMs: 20 });
    await runner.run({ ...base, cwd, prompt: "hi", session });
    expect(handle!.deliver("", true, STOP)).toBe(false);
  });
});
