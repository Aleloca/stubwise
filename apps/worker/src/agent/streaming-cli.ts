// apps/worker/src/agent/streaming-cli.ts
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { execa } from "execa";
import { INTERACTIVE_SEGMENTS, type AgentSegmentLabel } from "@stubwise/shared";
import { buildAgentEnv, type ClaudeCliRunnerOptions } from "./claude-cli.js";
import { buildCliArgs, validateRunOptions, withMcpConfig } from "./cli-args.js";
import { AGENT_PAUSE_BUDGET_MS, PauseBudgets } from "./pause-budget.js";
import {
  AgentRunCancelledError,
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
 * - UN INTERVENTO NON SOSTITUISCE IL DELIVERABLE (design §12, I1 della review
 *   finale): l'output di un run è l'ULTIMO `result`, quindi un messaggio che
 *   apre un turno dopo il lavoro finito farebbe della risposta al maintainer
 *   («Ok, ne tengo conto») l'output. Tre difese: (1) al testo scritto su stdin
 *   — e SOLO lì: non all'evento `input`, non al commento sul ticket — si
 *   accoda `DELIVERABLE_REMINDER`; (2) nei segmenti il cui deliverable è
 *   l'OUTPUT (`SEGMENT_DELIVERABLE`) l'handle smette di accettare interventi
 *   al primo `result` RIUSCITO (un errore da interrupt non chiude): `deliver` risponde false, il relay marca l'input
 *   `undelivered` (`stdin_closed`, visibile a chi l'ha scritto) e nessun turno
 *   nuovo parte; (3) `inputsDelivered` nel risultato dice al chiamante che il
 *   run ha ricevuto interventi, così la pipeline può verificare la forma del
 *   deliverable (il piano: `planHasRequiredShape`, pipeline/prompts.ts).
 * - CODA ALL'ECO (design queue-stop §1): l'argv ha `--replay-user-messages`, e
 *   ogni intervento va su stdin con l'uuid = id della riga
 *   `agent_session_inputs`. Il CLI lo riemette (`isReplay`) quando lo PRENDE —
 *   assorbito a metà turno, o all'inizio del turno successivo — ed è LÌ che
 *   nasce l'evento `input`, non alla scrittura: fino ad allora il client lo
 *   mostra «In coda». Un'eco senza uno dei nostri uuid (il prompt iniziale) si
 *   ignora. Ciò che è stato scritto e non ha avuto l'eco quando il segmento
 *   finisce torna al relay (`SessionHooks.inputsNotEchoed`), che lo marca
 *   `undelivered` (`stdin_closed`): niente resta «in coda» per sempre.
 * - «FERMA» SENZA TESTO (design queue-stop §2): un intervento `interrupt` col
 *   testo vuoto manda SOLO il control_request (nessun messaggio, quindi
 *   nessuna eco, mai spazzato: resta `delivered`, ed è ciò su cui il server
 *   deriva «in pausa») e mette l'handle in PAUSA: la grazia non chiude stdin,
 *   il timeout dell'agente si sospende (la pausa non mangia il tempo del
 *   lavoro), il segmento resta vivo (l'heartbeat del sink e quello del job
 *   battono da sé). Un messaggio chiude la pausa e il run continua. Il tetto è
 *   TOTALE per lavoro (`AGENT_PAUSE_BUDGET_MS`, somma delle pause di tutti i
 *   segmenti con la stessa `pauseKey`): scaduto, stdin si chiude e il run
 *   lancia `AgentRunCancelledError` — un ANNULLAMENTO, non un fallimento: il
 *   chiamante chiude il lavoro come saltato, senza commit né notifica di
 *   fallimento. Vale per ogni segmento in cui `canInterrupt` lo permette, cioè
 *   ogni segmento interattivo: tutti i loro chiamanti gestiscono l'esito.
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
/**
 * Accodato al testo di un intervento SOLO su stdin (vedi il docblock del
 * modulo). Inglese neutro: il runner non conosce la lingua dei contenuti
 * dell'istanza, e il modello lo capisce in ogni caso.
 */
export const DELIVERABLE_REMINDER =
  "After taking this into account, complete the deliverable in the form originally requested.";

/**
 * Dove sta il deliverable di ogni segmento INTERATTIVO (le chiavi sono
 * esattamente `INTERACTIVE_SEGMENTS`, lo verifica un test):
 * - `output`: il deliverable è il messaggio finale del run, cioè l'ultimo
 *   `result` — il piano (`plan`, `plan_resume` → `plan_text`), il JSON del
 *   deep dive (`deep_dive` → `parseAgentJson`), la risposta della chat di
 *   analisi (`chat_turn` → messaggio della voce). Qui un turno in più dopo il
 *   primo `result` SOSTITUIREBBE il deliverable: l'handle chiude agli
 *   interventi al primo `result` riuscito.
 * - `files`: il deliverable sono le modifiche nel worktree e il report su
 *   file; l'output finisce solo nel log del job (`execute`, `self_repair`,
 *   `correction`, `correction_self_repair`). Un turno in più nella grazia
 *   lavora ancora sui file: gli interventi restano accettati finché stdin è
 *   aperto.
 * Un segmento reso interattivo senza una voce qui fa fallire quel test: chi lo
 * aggiunge deve decidere dove sta il suo deliverable.
 */
export const SEGMENT_DELIVERABLE: Partial<Record<AgentSegmentLabel, "output" | "files">> = {
  plan: "output",
  plan_resume: "output",
  deep_dive: "output",
  chat_turn: "output",
  execute: "files",
  self_repair: "files",
  correction: "files",
  correction_self_repair: "files",
};

/** Variabili d'ambiente del figlio che portano una credenziale (vedi buildAgentEnv). */
const CREDENTIAL_ENV_NAMES = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface SegmentSink {
  onStart(capabilities: string[]): void;
  onEvents(events: SessionEventDraft[]): void;
  onPartial(text: string): void;
  onEnd(info: { exitCode: number | null; timedOut: boolean }): Promise<void>;
  /**
   * L'handle di un segmento INTERATTIVO ha smesso di accettare interventi, a
   * processo ancora vivo: al primo `result` riuscito se il deliverable è
   * nell'OUTPUT (`SEGMENT_DELIVERABLE`), alla chiusura di stdin a fine grazia
   * se è nei FILE. Chi registra lo rende visibile SUBITO al server, che smette
   * di dire `canWrite` invece di aspettare la fine del segmento. Al più una
   * volta per segmento. Facoltativo: un sink che non lo implementa non cambia
   * niente (il relay marca comunque `stdin_closed` ciò che arriva dopo).
   */
  onInputsClosed?(): void;
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
  /**
   * A fine segmento: gli interventi scritti su stdin che il CLI non ha mai
   * preso (nessuna eco). Chi registra li marca `undelivered` (`stdin_closed`).
   * Mai lo «Ferma» senza testo: non ha eco per costruzione. Facoltativo.
   */
  inputsNotEchoed?(sessionId: string, inputIds: string[]): Promise<void>;
}

const NOOP_SINK: SegmentSink = {
  onStart: () => undefined,
  onEvents: () => undefined,
  onPartial: () => undefined,
  onEnd: async () => undefined,
  onInputsClosed: () => undefined,
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
    onInputsClosed: guard("onInputsClosed", () => sink.onInputsClosed?.()),
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

/** Riga utente per stdin; con `uuid` il CLI la riemette con lo stesso uuid. */
const userMessage = (content: string, uuid?: string) =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(uuid !== undefined ? { uuid } : {}),
  })}\n`;

const interruptRequest = () =>
  `${JSON.stringify({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } })}\n`;

/**
 * Margine del timeout di RISERVA di execa sopra timeout dell'agente + pausa
 * ancora disponibile: il timeout vero è il timer del runner (sospeso in
 * pausa); questo scatta solo se quel timer non ha fermato il processo.
 */
const BACKSTOP_SLACK_MS = 60_000;

export class StreamingClaudeRunner implements AgentRunner {
  private readonly claudePath: string;
  private readonly extraEnv: Record<string, string> | undefined;
  private readonly hooks: SessionHooks | undefined;
  private readonly graceMs: number;
  private readonly log: (msg: string) => void;
  /** Budget della pausa per lavoro (`pauseKey`), condiviso fra i run. */
  private readonly pauseBudgets: PauseBudgets;

  constructor(
    options: ClaudeCliRunnerOptions & {
      hooks?: SessionHooks;
      resultGraceMs?: number;
      /** SOLO per i test: in produzione è `AGENT_PAUSE_BUDGET_MS`. */
      pauseBudgetMs?: number;
      log?: (msg: string) => void;
    } = {},
  ) {
    this.claudePath = options.claudePath ?? "claude";
    this.extraEnv = options.extraEnv;
    this.hooks = options.hooks;
    this.graceMs = options.resultGraceMs ?? RESULT_GRACE_MS;
    this.log = options.log ?? ((msg) => console.warn(msg));
    this.pauseBudgets = new PauseBudgets(options.pauseBudgetMs ?? AGENT_PAUSE_BUDGET_MS);
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
    /** Deliverable nell'output: niente interventi dopo il primo `result` (vedi il docblock). */
    const outputDeliverable =
      session !== undefined && SEGMENT_DELIVERABLE[session.label] === "output";
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

    const pauseKey = session?.pauseKey ?? `segment:${segmentId}`;
    const budgets = this.pauseBudgets;
    const start = () =>
      execa(this.claudePath, args, {
        cwd: opts.cwd,
        stdin: "pipe",
        // Riserva: il timeout vero è `activeTimer` qui sotto, che si sospende
        // in pausa. La pausa può allungare il run al più di ciò che resta del
        // budget di questo lavoro.
        timeout: opts.timeoutMs + budgets.remainingMs(pauseKey) + BACKSTOP_SLACK_MS,
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
    /** false dal primo `result` RIUSCITO di un segmento con il deliverable nell'output. */
    let acceptingInputs = true;
    /** Interventi davvero scritti su stdin in questo segmento. */
    let inputsDelivered = 0;
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
    /**
     * Al più UNA volta per segmento, qualunque sia la causa: il primo `result`
     * riuscito di un segmento col deliverable nell'output, o la chiusura di
     * stdin a fine grazia di uno coi file.
     */
    let inputsClosedSignalled = false;
    const signalInputsClosed = () => {
      if (inputsClosedSignalled || !interactive) return;
      inputsClosedSignalled = true;
      sink.onInputsClosed?.();
    };
    /**
     * Chiusura di stdin DOPO un `result` (grazia scaduta, o subito senza
     * grazia): da qui `deliver` risponde false, e il server deve smettere di
     * dire canWrite adesso, non quando il processo esce. Non la usa il
     * `finally`: lì il segmento è già finito (onEnd), e il segnale non serve.
     */
    const closeStdinAfterResult = () => {
      if (stdinOpen) signalInputsClosed();
      closeStdin();
    };
    const write = (line: string): boolean => {
      if (!stdinOpen || child.stdin === null || child.stdin.destroyed) return false;
      child.stdin.write(line);
      return true;
    };

    /**
     * TIMEOUT dell'agente, sospeso in pausa: `activeRemainingMs` è il tempo di
     * lavoro che resta, consumato solo fuori dalla pausa.
     */
    let activeRemainingMs = opts.timeoutMs;
    let activeSince = Date.now();
    let activeTimer: NodeJS.Timeout | null = null;
    let timedOutByRunner = false;
    const armActive = () => {
      activeSince = Date.now();
      activeTimer = setTimeout(() => {
        activeTimer = null;
        timedOutByRunner = true;
        // SIGTERM, poi SIGKILL dopo `forceKillAfterDelay`, come il timeout di execa.
        child.kill();
      }, Math.max(0, activeRemainingMs));
    };
    const suspendActive = () => {
      if (activeTimer === null) return;
      clearTimeout(activeTimer);
      activeTimer = null;
      activeRemainingMs -= Date.now() - activeSince;
    };

    /** Interventi scritti su stdin e non ancora ripresi dal CLI (eco), per uuid. */
    const awaitingEcho = new Map<string, { text: string; interrupt: boolean; meta: DeliveryMeta }>();

    /** La pausa di un «Ferma» senza testo (vedi il docblock del modulo). */
    let pause: { since: number; timer: NodeJS.Timeout; stoppedBy: string | null } | null = null;
    /** Pausa scaduta: il run finirà con AgentRunCancelledError. */
    let cancelledBy: { userId: string | null } | null = null;
    const enterPause = (meta: DeliveryMeta) => {
      clearGrace();
      suspendActive();
      pause = {
        since: Date.now(),
        stoppedBy: meta.authorUserId,
        timer: setTimeout(expirePause, budgets.remainingMs(pauseKey)),
      };
    };
    const leavePause = () => {
      if (pause === null) return;
      clearTimeout(pause.timer);
      budgets.consume(pauseKey, Date.now() - pause.since);
      pause = null;
      armActive();
    };
    function expirePause() {
      if (pause === null) return;
      budgets.consume(pauseKey, Date.now() - pause.since);
      cancelledBy = { userId: pause.stoppedBy };
      pause = null;
      // Il CLI fermo esce a stdin chiuso; se non lo facesse, il timeout
      // dell'agente (che riparte da dove era) lo ferma comunque.
      armActive();
      closeStdinAfterResult();
    }

    const handle: LiveProcessHandle = {
      label: session?.label,
      deliver: (text, interrupt, meta) => {
        if (!stdinOpen || !acceptingInputs) return false;
        if (text === "") {
          // Un messaggio vuoto non ha senso senza interrupt: non entra.
          if (!interrupt) return false;
          // «Ferma» senza testo: SOLO il control_request, nessuna riga utente
          // (quindi nessuna eco, mai spazzato). Già in pausa: niente da fare.
          if (pause === null) {
            if (!write(interruptRequest())) return false;
            enterPause(meta);
          }
          return true;
        }
        // In pausa il turno è già fermo: l'interrupt di «Ferma e scrivi» non serve.
        if (interrupt && pause === null) write(interruptRequest());
        // Il promemoria va SOLO su stdin: evento e commento hanno il testo nudo.
        const ok = write(userMessage(`${text}\n\n${DELIVERABLE_REMINDER}`, meta.inputId));
        if (ok) {
          inputsDelivered++;
          // La grazia si annulla solo se l'intervento è davvero partito:
          // altrimenti nessun turno nuovo la riarmerebbe.
          clearGrace();
          // L'evento `input` nasce all'eco (vedi il gestore delle righe).
          awaitingEcho.set(meta.inputId, { text, interrupt, meta });
          leavePause();
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
      // ECO di un intervento: il CLI l'ha preso ADESSO. Un'eco senza uno dei
      // nostri uuid (il prompt iniziale) non produce niente.
      if (ev.type === "user" && ev["isReplay"] === true && typeof ev["uuid"] === "string") {
        const echoed = awaitingEcho.get(ev["uuid"]);
        if (echoed !== undefined) {
          awaitingEcho.delete(ev["uuid"]);
          sink.onEvents([
            {
              type: "input",
              data: redact({
                text: echoed.text,
                interrupt: echoed.interrupt,
                inputId: echoed.meta.inputId,
                authorUserId: echoed.meta.authorUserId,
              }),
            },
          ]);
        }
      }
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
        // Solo un result RIUSCITO chiude: l'interrupt ("Ferma e scrivi") fa
        // emettere al CLI un `error_during_execution`, e il turno rediretto
        // che segue deve poter ricevere altri interventi (altrimenti il server
        // direbbe canWrite=true mentre l'handle rifiuta: due verità).
        if (
          acceptingInputs &&
          outputDeliverable &&
          ev["subtype"] === "success" &&
          ev["is_error"] !== true
        ) {
          acceptingInputs = false;
          // Subito, non alla fine della grazia: senza, il server direbbe
          // canWrite=true per tutta la grazia mentre `deliver` rifiuta.
          signalInputsClosed();
        }
        // In pausa nessuna grazia: il turno interrotto finisce col suo result,
        // ma stdin resta aperto per l'istruzione del maintainer.
        if (pause !== null) return;
        if (graceMs === 0) closeStdinAfterResult();
        else grace = setTimeout(closeStdinAfterResult, graceMs);
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
    armActive();
    /** Additivo: assente quando nessun intervento è arrivato al processo. */
    const delivered = () => (inputsDelivered > 0 ? { inputsDelivered } : {});

    try {
      let exitCode: number | null;
      let failure: { timedOut?: boolean; exitCode?: number; shortMessage?: string } | null = null;
      let raw: unknown = null;
      try {
        exitCode = (await child).exitCode ?? 0;
      } catch (error) {
        raw = error;
        failure = error as { timedOut?: boolean; exitCode?: number; shortMessage?: string };
        exitCode = failure.exitCode ?? null;
      }
      await drainStdout();
      const timedOut = timedOutByRunner || failure?.timedOut === true;
      await sink.onEnd({ exitCode, timedOut });
      // Prima del timeout: se la pausa è scaduta, la causa è quella.
      if (cancelledBy !== null) {
        throw new AgentRunCancelledError(
          (cancelledBy as { userId: string | null }).userId,
          fallbackOutput(),
          budgets.totalMs,
        );
      }
      if (timedOut) throw new AgentTimeoutError(opts.timeoutMs, fallbackOutput());
      if (failure === null) {
        return { ...tracker.toRunResult(exitCode ?? 0, fallbackOutput()), ...delivered() };
      }
      if (typeof failure.exitCode === "number") {
        // Usage e session id dall'ultimo result; l'output è il ripiego limitato.
        return { ...tracker.toRunResult(failure.exitCode, ""), output: fallbackOutput(), ...delivered() };
      }
      throw new AgentRunError(`Impossibile eseguire ${this.claudePath}: ${failure.shortMessage ?? String(raw)}`);
    } finally {
      if (activeTimer !== null) clearTimeout(activeTimer);
      const openPause = pause as { since: number; timer: NodeJS.Timeout } | null;
      if (openPause !== null) {
        // Processo uscito a metà pausa (crash, timeout di riserva): il tempo
        // passato in pausa conta comunque sul tetto del lavoro.
        clearTimeout(openPause.timer);
        budgets.consume(pauseKey, Date.now() - openPause.since);
      }
      closeStdin();
      // Scritti e mai presi dal CLI: tornano al relay (undelivered). Fail-open,
      // anche verso un hook che lancia in modo sincrono.
      const notEchoed = [...awaitingEcho.keys()];
      awaitingEcho.clear();
      const notEchoedHook = this.hooks?.inputsNotEchoed?.bind(this.hooks);
      if (notEchoed.length > 0 && session !== undefined && notEchoedHook !== undefined) {
        await Promise.resolve()
          .then(() => notEchoedHook(session.sessionId, notEchoed))
          .catch((error: unknown) => {
            this.log(`sessione: interventi senza eco non marcati: ${errorText(error)}`);
          });
      }
      unregister();
      lines.close();
    }
  }
}
