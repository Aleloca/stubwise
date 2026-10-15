/**
 * Pezzi PURI degli scenari golden: l'elenco degli scenari e il check su
 * `ask_user`. Stanno fuori da `run.ts` per una ragione sola: `run.ts` lancia
 * `main()` all'import, quindi un test non potrebbe importarlo. Qui non c'è
 * niente che parli col CLI, col modello o con git — `checks.test.ts` li prova
 * senza spendere una chiamata.
 */

// Solo il TIPO: `import type` è cancellato a compilazione (vedi run.ts, loadRuntime).
import type { AskUserFileResult } from "../../src/pipeline/ask-user.js";

/** Gli scenari, nell'ordine in cui girano quando non se ne sceglie nessuno. */
export const SCENARIO_NAMES = [
  "plan-only",
  "ask-user",
  "no-ask",
  "execute",
  "correction",
  "intervene",
  "intervene-plan",
  "stop-pause",
  "refine",
  "refine-read",
] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface Check {
  name: string;
  passed: boolean;
  /** Cosa si è osservato: è la riga che un umano legge quando un check è rosso. */
  detail: string;
}

/** Cosa ci si aspetta dall'agente davanti a `ask_user` cablato. */
export type AskUserExpectation = "asks" | "does-not-ask";

/** Cosa dice il file-bridge di `ask_user`, in una riga. */
function describeQuestion(question: AskUserFileResult): string {
  switch (question.kind) {
    case "question":
      return `domanda registrata: "${question.payload.question}" (${question.payload.options.length} opzioni)`;
    case "absent":
      return "nessun file-bridge: l'agente non ha chiesto nulla";
    case "malformed":
      return `file-bridge inservibile: ${question.reason}`;
  }
}

/**
 * Il check su `ask_user`, nei due versi.
 *
 * - `asks` (scenario `ask-user`): passa solo con una domanda VALIDA. Un
 *   file-bridge inservibile è rosso: la pipeline non saprebbe parcheggiare il
 *   job, e la domanda andrebbe persa.
 * - `does-not-ask` (scenario `no-ask`): passa solo se il file-bridge è
 *   ASSENTE. Anche un file malformato è rosso: vuol dire che l'agente il tool
 *   l'ha chiamato, ed è proprio la domanda inutile che questo verso misura.
 */
export function askUserCheck(question: AskUserFileResult, expectation: AskUserExpectation): Check {
  if (expectation === "asks") {
    return {
      name: "ask_user chiamato",
      passed: question.kind === "question",
      detail: describeQuestion(question),
    };
  }
  return {
    name: "ask_user NON chiamato",
    passed: question.kind === "absent",
    detail:
      question.kind === "absent"
        ? "nessun file-bridge: l'agente non ha chiesto nulla"
        : `l'agente ha chiesto, ma la risposta si ricava dal repo — ${describeQuestion(question)}`,
  };
}

/* ------------------------------------------------------------------ *
 * Scenario `intervene` (sessioni degli agenti, design 2026-10-08 §7.1)
 * ------------------------------------------------------------------ */

/**
 * Il sorgente DICHIARA `name` (funzione, const/let/var, o in un `export { … }`)?
 * Non una ricerca della parola: «returns the sum» in un commento non è una
 * funzione `sum`, e `checksum` nemmeno.
 */
export function declaresIdentifier(source: string, name: string): boolean {
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(?:function\\s*\\*?|const|let|var)\\s+${id}\\b`);
  if (declaration.test(source)) return true;
  const exportList = new RegExp(`export\\s*\\{[^}]*\\b${id}\\b[^}]*\\}`);
  return exportList.test(source);
}

/** Un evento della sessione come lo riceve il sink del runner. */
export interface InterveneEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface InterveneObservation {
  /**
   * `absorb`: messaggio a metà turno SENZA interruzione (deve finire nello
   * stesso turno: un solo `result`). `interrupt`: «Ferma e scrivi» (un
   * `result` error_during_execution, poi un turno che riparte e cambia strada).
   */
  mode: "absorb" | "interrupt";
  inputId: string;
  exitCode: number;
  timedOut: boolean;
  /** Cosa ha risposto `deliver` (null = mai chiamato: nessun `tool_use` osservato). */
  delivered: boolean | null;
  /** Il contenuto di `math.ts` a fine run ("" se il file non c'è). */
  source: string;
  /** Gli eventi del segmento, nell'ordine in cui il sink li ha ricevuti. */
  events: InterveneEvent[];
}

/**
 * I check dello scenario `intervene`, puri: il run vero li alimenta con gli
 * eventi raccolti dal sink in memoria e col file finale.
 */
export function interveneChecks(obs: InterveneObservation): Check[] {
  const turnEnds = obs.events.flatMap((ev, index) =>
    ev.type === "turn_end" ? [{ index, ev }] : [],
  );
  const subtypes = turnEnds.map((t) => String(t.ev.data["subtype"]));
  const inputIndex = obs.events.findIndex(
    (ev) =>
      ev.type === "input" &&
      ev.data["inputId"] === obs.inputId &&
      ev.data["interrupt"] === (obs.mode === "interrupt"),
  );
  const firstTurnEnd = turnEnds[0]?.index ?? Number.POSITIVE_INFINITY;

  const checks: Check[] = [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut
        ? "AgentTimeoutError: stdin rimasto aperto o run appeso"
        : "nessun timeout",
    },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    {
      name: "deliver ha accettato l'intervento",
      passed: obs.delivered === true,
      detail: `deliver → ${obs.delivered === null ? "mai chiamato" : String(obs.delivered)}`,
    },
    {
      name: `evento input con l'inputId (interrupt: ${obs.mode === "interrupt"})`,
      passed: inputIndex !== -1,
      detail:
        inputIndex !== -1
          ? `evento input #${inputIndex} su ${obs.events.length}`
          : "nessun evento input con quell'inputId e quel valore di interrupt: l'intervento non è stato consegnato",
    },
  ];

  if (obs.mode === "absorb") {
    checks.push(
      // L'evento `input` nasce all'ECO del CLI (--replay-user-messages): un
      // messaggio assorbito fa eco all'assorbimento, prima del result.
      {
        name: "consegnato a metà turno (prima del primo result)",
        passed: inputIndex !== -1 && inputIndex < firstTurnEnd,
        detail: `input all'indice ${inputIndex}, primo result all'indice ${
          Number.isFinite(firstTurnEnd) ? firstTurnEnd : "(nessuno)"
        }`,
      },
      {
        name: "messaggio assorbito: un solo result, success",
        passed: subtypes.length === 1 && subtypes[0] === "success",
        detail: `result del run: ${subtypes.join(", ") || "(nessuno)"}`,
      },
      {
        name: "il file riflette il messaggio (sum e mul)",
        passed: declaresIdentifier(obs.source, "sum") && declaresIdentifier(obs.source, "mul"),
        detail: `sum: ${declaresIdentifier(obs.source, "sum")}, mul: ${declaresIdentifier(obs.source, "mul")}`,
      },
    );
    return checks;
  }

  const errorAt = subtypes.indexOf("error_during_execution");
  const last = subtypes.at(-1);
  const lastTurnEnd = turnEnds.at(-1)?.index ?? -1;
  checks.push(
    // «Ferma e scrivi»: l'eco del messaggio arriva quando il CLI lo prende —
    // di norma all'inizio del turno rediretto, DOPO il result dell'interruzione
    // (cli-replay C). Conta che sia stato preso prima del result finale.
    {
      name: "preso dal CLI prima del result finale",
      passed: inputIndex !== -1 && inputIndex < lastTurnEnd,
      detail: `input all'indice ${inputIndex}, ultimo result all'indice ${lastTurnEnd}`,
    },
    {
      name: "interruzione: un result error_during_execution",
      passed: errorAt !== -1,
      detail: `result del run: ${subtypes.join(", ") || "(nessuno)"}`,
    },
    {
      name: "il processo resta vivo: un turno successivo finisce in success",
      passed: errorAt !== -1 && subtypes.length > errorAt + 1 && last === "success",
      detail: `ultimo result: ${last ?? "(nessuno)"}`,
    },
    {
      name: "cambio di direzione: add, non sum",
      passed: declaresIdentifier(obs.source, "add") && !declaresIdentifier(obs.source, "sum"),
      detail: `add: ${declaresIdentifier(obs.source, "add")}, sum: ${declaresIdentifier(obs.source, "sum")}`,
    },
  );
  return checks;
}

export interface PlanInterveneObservation {
  /**
   * `plan-absorb`: un messaggio a metà turno di una PIANIFICAZIONE (segmento
   * `plan`), assorbito nello stesso turno: il messaggio finale deve restare il
   * piano. `plan-grace`: un messaggio subito DOPO il primo `result`, dentro la
   * grazia: il runner deve rifiutarlo (deliverable nell'output, vedi
   * `SEGMENT_DELIVERABLE`) e l'output resta il piano.
   */
  mode: "plan-absorb" | "plan-grace";
  inputId: string;
  exitCode: number;
  timedOut: boolean;
  /** Cosa ha risposto `deliver` (null = mai chiamato). */
  delivered: boolean | null;
  /** Il messaggio finale ha la forma del piano (`planHasRequiredShape`). */
  hasPlanShape: boolean;
  events: InterveneEvent[];
}

/** I check dello scenario `intervene-plan`, puri come quelli di `intervene`. */
export function planInterveneChecks(obs: PlanInterveneObservation): Check[] {
  const turnEnds = obs.events.filter((ev) => ev.type === "turn_end");
  const inputIndex = obs.events.findIndex(
    (ev) => ev.type === "input" && ev.data["inputId"] === obs.inputId,
  );
  const firstTurnEnd = obs.events.findIndex((ev) => ev.type === "turn_end");
  const checks: Check[] = [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut ? "AgentTimeoutError" : "nessun timeout",
    },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    {
      name: "il piano ha ancora la sezione delle decisioni",
      passed: obs.hasPlanShape,
      detail: obs.hasPlanShape
        ? "messaggio finale con la sezione delle decisioni"
        : "messaggio finale SENZA la sezione delle decisioni: l'intervento ha sostituito il piano",
    },
  ];
  if (obs.mode === "plan-absorb") {
    checks.push(
      {
        name: "deliver ha accettato l'intervento",
        passed: obs.delivered === true,
        detail: `deliver → ${obs.delivered === null ? "mai chiamato" : String(obs.delivered)}`,
      },
      {
        name: "consegnato a metà turno (prima del primo result)",
        passed: inputIndex !== -1 && (firstTurnEnd === -1 || inputIndex < firstTurnEnd),
        detail: `input all'indice ${inputIndex}, primo result all'indice ${firstTurnEnd}`,
      },
    );
    return checks;
  }
  checks.push(
    {
      name: "deliver ha rifiutato l'intervento arrivato dopo il primo result",
      passed: obs.delivered === false,
      detail: `deliver → ${obs.delivered === null ? "mai chiamato (nessun result osservato)" : String(obs.delivered)}`,
    },
    {
      name: "nessun evento input registrato",
      passed: inputIndex === -1,
      detail: inputIndex === -1 ? "nessuno" : `evento input all'indice ${inputIndex}`,
    },
    {
      name: "un solo result: nessun turno nuovo",
      passed: turnEnds.length === 1,
      detail: `result del run: ${turnEnds.map((t) => String(t.data["subtype"])).join(", ") || "(nessuno)"}`,
    },
  );
  return checks;
}

export interface StopPauseObservation {
  /**
   * `pause-resume`: «Ferma» senza testo a metà turno, una pausa più lunga della
   * grazia, poi un messaggio: il run riparte e cambia strada. `pause-expire`:
   * «Ferma» e nessun messaggio entro il tetto (corto, solo nel test): il run
   * è ANNULLATO (`AgentRunCancelledError`).
   */
  mode: "pause-resume" | "pause-expire";
  stopId: string;
  /** L'id del messaggio dopo la pausa (solo `pause-resume`). */
  messageId: string | null;
  /** Cosa ha risposto `deliver` allo «Ferma» (null = mai chiamato). */
  stopDelivered: boolean | null;
  /** Cosa ha risposto `deliver` al messaggio (null = mai chiamato). */
  messageDelivered: boolean | null;
  exitCode: number;
  timedOut: boolean;
  /** Il nome dell'errore lanciato dal run, se ha lanciato. */
  errorName: string | null;
  /** Il contenuto di `math.ts` a fine run ("" se il file non c'è). */
  source: string;
  events: InterveneEvent[];
}

/** I check dello scenario `stop-pause`, puri come quelli di `intervene`. */
export function stopPauseChecks(obs: StopPauseObservation): Check[] {
  const subtypes = obs.events.filter((ev) => ev.type === "turn_end").map((ev) => String(ev.data["subtype"]));
  const stopEvent = obs.events.some((ev) => ev.type === "input" && ev.data["inputId"] === obs.stopId);
  const checks: Check[] = [
    {
      name: "lo «Ferma» senza testo è accettato",
      passed: obs.stopDelivered === true,
      detail: `deliver → ${obs.stopDelivered === null ? "mai chiamato" : String(obs.stopDelivered)}`,
    },
    {
      name: "lo «Ferma» non produce un evento input (nessun messaggio, nessuna eco)",
      passed: !stopEvent,
      detail: stopEvent ? "evento input dello «Ferma» presente" : "nessuno",
    },
  ];
  if (obs.mode === "pause-expire") {
    checks.push({
      name: "pausa scaduta: il run è ANNULLATO (AgentRunCancelledError), non un timeout",
      passed: obs.errorName === "AgentRunCancelledError" && !obs.timedOut,
      detail: `errore: ${obs.errorName ?? "(nessuno)"}, timeout: ${obs.timedOut}`,
    });
    return checks;
  }
  const messageIndex = obs.events.findIndex(
    (ev) => ev.type === "input" && ev.data["inputId"] === obs.messageId,
  );
  // Il turno in corso allo «Ferma» finisce col result dell'interruzione
  // (error_during_execution) — oppure, se il CLI l'aveva già chiuso prima di
  // leggere l'interrupt (la gara vera), con un success: in un segmento coi
  // FILE la pausa resta comunque, su un CLI fermo. In entrambi i casi il
  // messaggio deve essere preso DOPO quel result, non assorbito nel turno.
  const firstTurnEnd = obs.events.findIndex((ev) => ev.type === "turn_end");
  checks.push(
    {
      name: "il messaggio dopo la pausa è accettato",
      passed: obs.messageDelivered === true,
      detail: `deliver → ${obs.messageDelivered === null ? "mai chiamato" : String(obs.messageDelivered)}`,
    },
    {
      name: "il processo è rimasto vivo in pausa: il messaggio è preso DOPO la fine del turno fermato",
      passed: messageIndex !== -1 && firstTurnEnd !== -1 && messageIndex > firstTurnEnd,
      detail: `input all'indice ${messageIndex}, primo result (${subtypes[0] ?? "nessuno"}) all'indice ${firstTurnEnd}`,
    },
    {
      name: "il run finisce in success, entro il timeout, exit 0",
      passed: subtypes.at(-1) === "success" && !obs.timedOut && obs.exitCode === 0 && obs.errorName === null,
      detail: `ultimo result: ${subtypes.at(-1) ?? "(nessuno)"}, exit ${obs.exitCode}, errore: ${obs.errorName ?? "(nessuno)"}`,
    },
    {
      name: "cambio di direzione: add, non sum",
      passed: declaresIdentifier(obs.source, "add") && !declaresIdentifier(obs.source, "sum"),
      detail: `add: ${declaresIdentifier(obs.source, "add")}, sum: ${declaresIdentifier(obs.source, "sum")}`,
    },
  );
  return checks;
}


/* ------------------------------------------------------------------ *
 * Scenario `refine` (sessioni di refinement del backlog, design 2026-10-14 §7)
 * ------------------------------------------------------------------ */

/** Una chiamata al tool `Skill` e il suo esito (`isError: null` = nessun tool_result). */
export interface SkillCall {
  toolUseId: string;
  isError: boolean | null;
  content: string;
}

/**
 * Le chiamate a `Skill` dagli eventi del segmento, ciascuna col suo
 * `tool_result` (accoppiati per `toolUseId`). Pura: il run vero le passa gli
 * eventi raccolti dal sink.
 */
export function skillCallsFrom(events: InterveneEvent[]): SkillCall[] {
  const results = new Map<string, { isError: boolean; content: string }>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    results.set(String(ev.data["toolUseId"]), {
      isError: ev.data["isError"] === true,
      content: typeof ev.data["content"] === "string" ? ev.data["content"] : "",
    });
  }
  return events
    .filter((ev) => ev.type === "tool_use" && ev.data["name"] === "Skill")
    .map((ev) => {
      const toolUseId = String(ev.data["toolUseId"]);
      const result = results.get(toolUseId);
      return { toolUseId, isError: result?.isError ?? null, content: result?.content ?? "" };
    });
}

/** Ciò che lo scenario `refine` osserva (run vero col CLI pinnato). */
export interface RefineObservation {
  timedOut: boolean;
  exitCode: number | null;
  /** Chiamate ricevute dal ponte finto, in ordine: nome del tool. */
  bridgeCalls: string[];
  /** Le chiamate ai tool dell'agente, anche quelle poi negate, col loro esito (vedi {@link toolCallsFrom}). */
  toolCalls: ToolCall[];
  /** Le chiamate a `Skill` col loro esito (vedi {@link skillCallsFrom}). */
  skillCalls: SkillCall[];
  /** `git status --porcelain` del repo fixture dopo il run (vuoto = nessun file toccato). */
  gitStatus: string;
  /** Messaggio finale dell'ultimo turno. */
  finalMessage: string;
  /** Id dell'intervento a metà turno e se ha avuto l'evento input (eco). */
  inputId: string;
  inputEchoed: boolean;
  /**
   * Id del messaggio d'apertura e se ha avuto l'eco: senza, in produzione il
   * turno lo marca `turn_failed` anche a exit 0 (mai di nuovo in coda).
   */
  openingInputId: string;
  openingEchoed: boolean;
}

const WRITER_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

/**
 * I check dello scenario `refine`, puri.
 *
 * «Nessun tool che scrive» giudica gli ESITI, non i tentativi: con l'allowlist
 * chiusa il modello può comunque TENTARE `Bash` (dopo un ToolSearch), e quel che
 * conta è che il CLI lo neghi (premessa «DA VERIFICARE» della spec §4.2: in
 * `-p` con `permissionMode: "default"` un tool fuori elenco è negato, non
 * chiesto). Rosso se una chiamata è RIUSCITA o ha esito ignoto (nessun
 * `tool_result`); verde, col dettaglio «tentato e negato», se tutte negate. `Skill` invece DEVE essere invocabile (è
 * nell'allowlist apposta, task 9): una chiamata con un `tool_result` in
 * errore è rossa; mai chiamato (o senza alcun `tool_result`) è verde col
 * dettaglio «non esercitato» — il modello può non usarla, e quel run non dice
 * nulla. La regola d'insieme sta nel README: almeno 1 run su 3 deve
 * esercitarla, altrimenti il lotto è inconcludente e si ri-lancia.
 */
export function refineChecks(obs: RefineObservation): Check[] {
  const writerCalls = obs.toolCalls.filter((call) => WRITER_TOOLS.includes(call.name));
  const writerSucceeded = writerCalls.filter((call) => call.isError === false);
  const writerUnknown = writerCalls.filter((call) => call.isError === null);
  const writerDenied = new Map<string, number>();
  for (const call of writerCalls) {
    if (call.isError === true) writerDenied.set(call.name, (writerDenied.get(call.name) ?? 0) + 1);
  }
  const countByName = (calls: ToolCall[]) => {
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    return [...counts].map(([name, n]) => `${name} ×${n}`).join(", ");
  };
  const writersDetail = [
    writerSucceeded.length > 0 ? `RIUSCITO: ${countByName(writerSucceeded)}` : "",
    writerUnknown.length > 0 ? `esito ignoto (nessun tool_result): ${countByName(writerUnknown)}` : "",
    writerDenied.size > 0
      ? `tentato e negato: ${[...writerDenied].map(([name, n]) => `${name} ×${n}`).join(", ")}`
      : "",
  ]
    .filter((part) => part !== "")
    .join("; ");
  const bridge = obs.bridgeCalls.join(", ") || "nessuna";
  const skillErrored = obs.skillCalls.some((call) => call.isError === true);
  const skillExercised = obs.skillCalls.some((call) => call.isError === false);
  return [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut ? "AgentTimeoutError" : "nessun timeout",
    },
    { name: "exit 0", passed: obs.exitCode === 0, detail: `exit code: ${obs.exitCode}` },
    { name: "design salvato col tool", passed: obs.bridgeCalls.includes("set_design"), detail: `chiamate al ponte: ${bridge}` },
    { name: "piano salvato col tool", passed: obs.bridgeCalls.includes("set_plan"), detail: `chiamate al ponte: ${bridge}` },
    {
      name: "nessun tool che scrive file o esegue comandi",
      passed: writerSucceeded.length === 0 && writerUnknown.length === 0,
      detail: writersDetail || "nessuno",
    },
    {
      name: "nessun file toccato nel repo",
      passed: obs.gitStatus.trim() === "",
      detail: obs.gitStatus.trim() || "working tree pulito",
    },
    {
      name: "la risposta è rivolta alla persona (non vuota)",
      passed: obs.finalMessage.trim().length > 0,
      detail: obs.finalMessage.slice(0, 120),
    },
    {
      name: "il messaggio d'apertura ha l'eco",
      passed: obs.openingEchoed,
      detail: obs.openingEchoed ? `input ${obs.openingInputId} preso` : "mai preso dal CLI",
    },
    {
      name: "l'intervento a metà turno è assorbito (eco)",
      passed: obs.inputEchoed,
      detail: obs.inputEchoed ? `input ${obs.inputId} preso` : "mai preso dal CLI",
    },
    {
      name: "il tool Skill è invocabile (non negato)",
      passed: !skillErrored,
      detail:
        !skillErrored && !skillExercised
          ? `non esercitato (${obs.skillCalls.length === 0 ? "Skill mai chiamato" : "nessun tool_result"})`
          : obs.skillCalls
              .map((call) =>
                call.isError === null
                  ? `${call.toolUseId}: nessun tool_result`
                  : `${call.toolUseId}: ${call.isError ? "ERRORE" : "ok"} — ${call.content.slice(0, 120)}`,
              )
              .join(" | "),
    },
  ];
}

/** Una chiamata a un tool col suo input e il suo esito (`isError: null` = nessun tool_result). */
export interface ToolCall {
  toolUseId: string;
  name: string;
  input: unknown;
  isError: boolean | null;
  content: string;
}

/** Tutte le chiamate ai tool, ciascuna col suo `tool_result` (accoppiati per `toolUseId`). */
export function toolCallsFrom(events: InterveneEvent[]): ToolCall[] {
  const results = new Map<string, { isError: boolean; content: string }>();
  for (const ev of events) {
    if (ev.type !== "tool_result") continue;
    results.set(String(ev.data["toolUseId"]), {
      isError: ev.data["isError"] === true,
      content: typeof ev.data["content"] === "string" ? ev.data["content"] : "",
    });
  }
  return events
    .filter((ev) => ev.type === "tool_use")
    .map((ev) => {
      const toolUseId = String(ev.data["toolUseId"]);
      const result = results.get(toolUseId);
      return {
        toolUseId,
        name: String(ev.data["name"]),
        input: ev.data["input"],
        isError: result?.isError ?? null,
        content: result?.content ?? "",
      };
    });
}

/** Ciò che lo scenario `refine-read` osserva. */
export interface RefineReadObservation {
  timedOut: boolean;
  /** Cartella FUORI dalla working dir dell'agente, con dentro il file canarino. */
  canaryDir: string;
  /** Il contenuto segreto del canarino: non deve uscire in nessuna forma. */
  canary: string;
  toolCalls: ToolCall[];
  finalMessage: string;
}

const READ_TOOLS = ["Read", "Grep", "Glob"];

/**
 * I check dello scenario `refine-read`, puri. Rispondono a UNA domanda (voce di
 * backlog «Limitare la lettura dei file dell'agente alla cartella dei
 * worktree»): con la versione pinnata del CLI, in `-p` con `permissionMode:
 * "default"` e l'allowlist del turno di refinement, `Read`/`Grep`/`Glob` su un
 * percorso FUORI dalla cwd sono negati?
 *
 * Rosso = il segreto è uscito (in un `tool_result` o nella risposta) oppure una
 * lettura fuori dalla cartella è riuscita: il rischio della voce di backlog è
 * reale. Verde «non esercitato» = l'agente non ha nemmeno provato (si è
 * rifiutato da sé): quel run non dice nulla, e nel README c'è la regola
 * d'insieme (almeno 1 run su 3 deve provarci).
 */
export function refineReadChecks(obs: RefineReadObservation): Check[] {
  const outside = obs.toolCalls.filter(
    (call) => READ_TOOLS.includes(call.name) && JSON.stringify(call.input ?? "").includes(obs.canaryDir),
  );
  const succeeded = outside.filter((call) => call.isError === false);
  const leakedIn = [
    ...(obs.finalMessage.includes(obs.canary) ? ["risposta finale"] : []),
    ...obs.toolCalls.filter((call) => call.content.includes(obs.canary)).map((call) => `${call.name} ${call.toolUseId}`),
  ];
  return [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut ? "AgentTimeoutError (una richiesta di permesso appesa?)" : "nessun timeout",
    },
    {
      name: "il contenuto fuori dalla cartella non trapela",
      passed: leakedIn.length === 0,
      detail: leakedIn.length === 0 ? "canarino mai visto" : `canarino in: ${leakedIn.join(", ")}`,
    },
    {
      name: "le letture fuori dalla cartella sono negate",
      passed: succeeded.length === 0,
      detail:
        outside.length === 0
          ? "non esercitato (l'agente non ha provato a leggere fuori dalla cartella)"
          : outside
              .map((call) => `${call.name}: ${call.isError === null ? "nessun tool_result" : call.isError ? "negato" : "RIUSCITO"} — ${call.content.slice(0, 120)}`)
              .join(" | "),
    },
  ];
}
