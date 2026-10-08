// apps/worker/src/agent/streaming-cli.ts
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { INTERACTIVE_SEGMENTS, type AgentSegmentLabel } from "@stubwise/shared";
import { buildAgentEnv, type ClaudeCliRunnerOptions } from "./claude-cli.js";
import { buildCliArgs, validateRunOptions, withMcpConfig } from "./cli-args.js";
import {
  AgentRunError,
  AgentTimeoutError,
  type AgentRunner,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRunSession,
} from "./runner.js";
import { createRedactor } from "../sessions/redact.js";
import {
  ResultTracker,
  capabilitiesOf,
  parseStreamLine,
  partialTextOf,
  toSessionEvents,
  type SessionEventDraft,
} from "../sessions/stream-parser.js";

/**
 * Runner in streaming bidirezionale (design 2026-10-08-agent-sessions §5).
 * Stesso contratto di ClaudeCliRunner (exit non-zero = risultato, timeout =
 * AgentTimeoutError, spawn fallito = AgentRunError), più:
 * - gli eventi del run vanno a un SegmentSink (fail-open: un sink che lancia
 *   non tocca il run);
 * - stdin resta aperto: un LiveProcessHandle registrato per la sessione
 *   consegna gli interventi;
 * - CHIUSURA: dopo un `result`, se per RESULT_GRACE_MS non arriva né un
 *   turno nuovo né un intervento, si chiude stdin e il CLI esce (le righe
 *   fuori turno, come un system/status tardivo, non contano: continuesTurn).
 *   Non si contano i turni: un messaggio a metà turno viene ASSORBITO nello
 *   stesso turno (verificato sulla 2.1.287), quindi i `result` non sono uno per messaggio. Un segmento
 *   NON interattivo (nessuno può scrivergli) chiude subito: grazia 0.
 * - CAPABILITIES: il CLI 2.1.287 riemette `system/init` all'inizio di OGNI
 *   turno (due init nelle tracce a due turni): `onStart` si chiama solo al
 *   primo, gli altri non producono niente.
 * - MEMORIA: lo stdout non è bufferizzato da execa (`buffer: false`): si legge
 *   solo riga per riga. Dello stderr si tiene una coda di STDERR_TAIL_CHARS.
 *   Su exit non-zero o timeout l'output è il testo dell'ultimo `result` più
 *   quella coda: mai l'intero stream-json (gonfierebbe log del job e prompt
 *   del riassunto del fallimento).
 * - SEGRETI: oltre a `session.secrets`, il runner oscura da sé la credenziale
 *   del provider, i valori di `extraEnv` e le credenziali dell'ambiente del
 *   figlio: chi chiama non deve ricordarsene.
 */

export const RESULT_GRACE_MS = 2000;
/** Quanto stderr si tiene per l'output di un exit non-zero o di un timeout. */
export const STDERR_TAIL_CHARS = 16_384;
/**
 * Attesa massima della fine dello stdout dopo l'uscita del processo: un
 * nipote (server MCP, comando in background) che ha ereditato la pipe la
 * terrebbe aperta per sempre.
 */
const STDOUT_DRAIN_MS = 1000;
/** Variabili d'ambiente del figlio che portano una credenziale (vedi buildAgentEnv). */
const CREDENTIAL_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface SegmentSink {
  onStart(capabilities: string[]): void;
  onEvents(events: SessionEventDraft[]): void;
  onPartial(text: string): void;
  onEnd(info: { exitCode: number | null; timedOut: boolean }): Promise<void>;
}

/** Chi ha scritto l'intervento: finisce nei dati dell'evento `input`. */
export interface DeliveryMeta {
  inputId: string;
  authorUserId: string | null;
}

export interface LiveProcessHandle {
  /**
   * false se stdin è già chiuso: l'intervento è undelivered.
   *
   * Nota sul caso limite: `write` risponde true in modo sincrono, mentre un
   * EPIPE sollevato in modo asincrono nello stesso istante in cui il CLI esce
   * viene inghiottito dal listener no-op su stdin. Un messaggio scritto in quel
   * preciso momento risulta quindi consegnato anche se il CLI non l'ha mai
   * letto. Accettato: il run sta comunque terminando.
   */
  deliver(text: string, interrupt: boolean, meta: DeliveryMeta): boolean;
  /**
   * Il segmento di questo processo (facoltativo): il relay lo usa per dire nel
   * commento sul ticket DOVE è arrivato l'intervento, anche quando sulla
   * sessione non c'è più un segmento attivo.
   */
  label?: AgentSegmentLabel;
}

export interface SessionHooks {
  openSegment(session: AgentRunSession, segmentId: string, interactive: boolean): SegmentSink;
  register(sessionId: string, handle: LiveProcessHandle): () => void;
}

const NOOP_SINK: SegmentSink = {
  onStart: () => undefined,
  onEvents: () => undefined,
  onPartial: () => undefined,
  onEnd: async () => undefined,
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Avvolge un sink in modo che nessuna sua eccezione esca (fail-open). */
function safeSink(sink: SegmentSink, log: (msg: string) => void): SegmentSink {
  const guard =
    <A extends unknown[]>(name: string, fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch (error) {
        log(`sessione: ${name} fallito: ${errorText(error)}`);
      }
    };
  return {
    onStart: guard("onStart", (c: string[]) => sink.onStart(c)),
    onEvents: guard("onEvents", (e: SessionEventDraft[]) => sink.onEvents(e)),
    onPartial: guard("onPartial", (p: string) => sink.onPartial(p)),
    onEnd: async (info) => {
      try {
        await sink.onEnd(info);
      } catch (error) {
        log(`sessione: onEnd fallito: ${errorText(error)}`);
      }
    },
  };
}

/**
 * Una riga che apre o prosegue un turno, e quindi annulla la grazia dopo un
 * `result`: un turno nuovo finirà con un altro `result`, che la riarma. Le
 * altre (system/status, hook, rate_limit_event…) possono arrivare DOPO
 * l'ultimo `result` senza che nessun turno segua: se annullassero la grazia,
 * stdin resterebbe aperto fino al timeout e un run finito diventerebbe un
 * AgentTimeoutError.
 */
function continuesTurn(ev: { type: string; [key: string]: unknown }): boolean {
  if (ev.type === "assistant" || ev.type === "user" || ev.type === "stream_event") return true;
  return ev.type === "system" && ev["subtype"] === "init";
}

const userMessage = (content: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null })}\n`;

export class StreamingClaudeRunner implements AgentRunner {
  private readonly claudePath: string;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly hooks: SessionHooks | undefined;
  private readonly graceMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    options: ClaudeCliRunnerOptions & {
      hooks?: SessionHooks;
      resultGraceMs?: number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraEnv = options.extraEnv;
    this.hooks = options.hooks;
    this.graceMs = options.resultGraceMs ?? RESULT_GRACE_MS;
    this.log = options.log ?? ((msg) => console.warn(msg));
  }

  /** Registra le sessioni solo se ha dove scriverle (gli hook del relay). */
  get recordsSessions(): boolean {
    return this.hooks !== undefined;
  }

  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    validateRunOptions(opts);
    return withMcpConfig(opts, buildCliArgs(opts, "stream"), (args) => this.spawn(opts, args));
  }

  private async spawn(opts: AgentRunOptions, args: string[]): Promise<AgentRunResult> {
    const session = opts.session;
    const segmentId = randomUUID();
    const interactive = session !== undefined && INTERACTIVE_SEGMENTS.has(session.label);
    const graceMs = interactive ? this.graceMs : 0;
    const env = buildAgentEnv(process.env, this.extraEnv, opts.provider);
    const redact = createRedactor([
      ...(session?.secrets ?? []),
      ...(opts.provider !== undefined ? [opts.provider.secret] : []),
      ...Object.values(this.extraEnv ?? {}),
      ...CREDENTIAL_ENV_NAMES.flatMap((name) => (env[name] !== undefined ? [env[name]] : [])),
    ]);
    const sink =
      session !== undefined && this.hooks !== undefined
        ? safeSink(this.hooks.openSegment(session, segmentId, interactive), this.log)
        : NOOP_SINK;

    const start = () =>
      execa(this.claudePath, args, {
        cwd: opts.cwd,
        stdin: "pipe",
        timeout: opts.timeoutMs,
        // Al timeout: SIGTERM, poi SIGKILL dopo 5s se il processo non muore.
        forceKillAfterDelay: 5000,
        // Stessa allowlist dell'env del runner storico (vedi buildAgentEnv).
        extendEnv: false,
        env,
        // M1: niente buffer di execa. Lo stdout lo consuma readline, lo stderr
        // il listener qui sotto (con una coda limitata).
        buffer: false,
      });
    let child: ReturnType<typeof start>;
    try {
      child = start();
    } catch (error) {
      await sink.onEnd({ exitCode: null, timedOut: false });
      throw new AgentRunError(`Impossibile eseguire ${this.claudePath}: ${errorText(error)}`);
    }

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    // Una scrittura dopo l'uscita del CLI (EPIPE) non deve diventare
    // un'eccezione non gestita: l'esito lo decide il processo.
    child.stdin?.on("error", () => undefined);

    const tracker = new ResultTracker();
    /** Output di ripiego (exit non-zero, timeout, nessun result): mai lo stream intero. */
    const fallbackOutput = () =>
      [tracker.lastResultText, stderrTail].filter((part) => part !== "").join("\n");
    let stdinOpen = true;
    let started = false;
    let grace: NodeJS.Timeout | null = null;
    const clearGrace = () => {
      if (grace !== null) clearTimeout(grace);
      grace = null;
    };
    const closeStdin = () => {
      clearGrace();
      if (!stdinOpen) return;
      stdinOpen = false;
      child.stdin?.end();
    };
    const write = (line: string): boolean => {
      if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return false;
      child.stdin.write(line);
      return true;
    };

    const handle: LiveProcessHandle = {
      label: session?.label,
      deliver: (text, interrupt, meta) => {
        if (!stdinOpen) return false;
        if (interrupt) {
          write(
            `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`,
          );
        }
        const ok = write(userMessage(text));
        if (ok) {
          // La grazia si annulla solo se l'intervento è davvero partito:
          // altrimenti nessun turno nuovo la riarmerebbe.
          clearGrace();
          sink.onEvents([
            {
              type: "input",
              data: redact({ text, interrupt, inputId: meta.inputId, authorUserId: meta.authorUserId }),
            },
          ]);
        }
        return ok;
      },
    };
    const unregister =
      session !== undefined && interactive && this.hooks !== undefined
        ? this.hooks.register(session.sessionId, handle)
        : () => undefined;

    const lines = createInterface({ input: child.stdout! });
    const linesClosed = new Promise<void>((resolve) => lines.once("close", resolve));
    lines.on("line", (line) => {
      const ev = parseStreamLine(line);
      if (ev === null) return;
      if (continuesTurn(ev)) clearGrace();
      tracker.observe(ev);
      const caps = capabilitiesOf(ev);
      if (caps !== null && !started) {
        started = true;
        sink.onStart(caps);
      }
      const partial = partialTextOf(ev);
      if (partial !== null) sink.onPartial(redact(partial));
      const drafts = toSessionEvents(ev);
      if (drafts.length > 0) sink.onEvents(drafts.map((d) => ({ type: d.type, data: redact(d.data) })));
      if (ev.type === "result") {
        if (graceMs === 0) closeStdin();
        else grace = setTimeout(closeStdin, graceMs);
      }
    });

    /** Le ultime righe arrivano a readline dopo l'uscita: le si aspetta, con un tetto. */
    const drainStdout = async () => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        linesClosed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STDOUT_DRAIN_MS);
        }),
      ]);
      clearTimeout(timer);
    };

    write(userMessage(opts.prompt));

    try {
      const { exitCode } = await child;
      await drainStdout();
      await sink.onEnd({ exitCode: exitCode ?? 0, timedOut: false });
      return tracker.toRunResult(exitCode ?? 0, fallbackOutput());
    } catch (error) {
      const e = error as { timedOut?: boolean; exitCode?: number; shortMessage?: string };
      await drainStdout();
      await sink.onEnd({ exitCode: e.exitCode ?? null, timedOut: e.timedOut === true });
      if (e.timedOut === true) throw new AgentTimeoutError(opts.timeoutMs, fallbackOutput());
      if (typeof e.exitCode === "number") {
        // Usage e session id dall'ultimo result; l'output è il ripiego limitato.
        return { ...tracker.toRunResult(e.exitCode, ""), output: fallbackOutput() };
      }
      throw new AgentRunError(`Impossibile eseguire ${this.claudePath}: ${e.shortMessage ?? String(error)}`);
    } finally {
      closeStdin();
      unregister();
      lines.close();
    }
  }
}
