import { validateServerPlan, type AttributionInput, type ServerPlan } from "@stubwise/shared";
import { serverProjectsOf } from "../../domain/servers/projects";
import i18n from "../../i18n";
import {
  aiStartBlock,
  openWorkConversationAs,
  runIdentity,
  startOrHold,
} from "../api-mutations";
import {
  copy,
  currentPhase,
  eventsOf,
  onStoreReset,
  serverFixBlock,
  state,
  storeGeneration,
  visibleProjectIds,
} from "../store";
import { interruptScripts, notifyConversationChange, runScript } from "../stream";
import type { Conversation, EpisodeReason, ScriptStep, Task } from "../types";
import { can, viewerFor } from "../viewer";
import { forbidden, invalid, notFound, writer } from "../writer";
import { fixCheck, fixPlan, fixStepAction } from "./fixScripts";
import { docker } from "./scripts";
import { readSteps } from "./scripts";
import { liveEnvironments, serverFixStartBlock } from "./visibility";

// La correzione di un server, avviata da una task (area 8, F4b;
// anti-obiettivo 2). Due condizioni, sempre:
// 1. parte solo da una task legata a QUEL server (`serverRef`), avviata da
//    chi ha `servers.operate` nel progetto della task — Claude non l'ha mai
//    (R-L9), quindi la avvia sempre una persona;
// 2. nessun comando che CAMBIA il server precede un piano approvato da una
//    persona con `plans.approve` nel progetto della task, cioè quello che
//    l'analisi ha attribuito (R-L11: mai Claude) — anche se chi avvia può
//    approvare: il piano arriva SEMPRE da approvare (`planGateFor`), niente
//    approvazione in anticipo né «parte subito».
//
// Il piano è una sequenza di 1–10 azioni dell'insieme CHIUSO di
// `@stubwise/shared` (`SERVER_ACTIONS`), validata con `serverPlanSchema`:
// niente comandi liberi, niente script, niente deploy. La esegue l'AGENTE di
// monitoraggio, mai l'SSH, e solo con le sue operazioni accese
// (`agentOperations`): un'azione alla volta, ricontrollando prima di ognuna
// che il server sia ancora in un ambiente del progetto della task (R-L2,
// R-G5), che le operazioni siano accese e che nessuno l'abbia fermata. Poi
// il controllo finale (`resolved` esplicito, R-L3) e i modi di fermarsi —
// ognuno col suo segno nel flusso: lo Stop di una persona (`stoppedById`),
// le operazioni spente (`reason: "operations_off"`), il server tolto dal
// progetto (`server_gone`), un errore (`outcome: "failed"`). La revoca
// dell'accesso SSH NON la tocca: l'SSH è solo dell'analisi.
//
// Dopo il controllo finale la sessione si chiude SEMPRE (stesso script): il
// controllo è l'ultima cosa che fa. La task resta aperta: la chiude una
// persona.

/**
 * Per sessione: il turno di chi la guida. Ogni guida (piano, esecuzione)
 * prende un turno; uno Stop lo cambia SUBITO, così la guida di prima non
 * accoda più niente — nemmeno un'azione già decisa.
 */
const turns = new Map<string, number>();
/** Per sessione: il piano scritto per ultimo, cioè quello che si approva. */
const planned = new Map<string, ServerPlan>();
/** Per sessione: le note di chi ha avviato la correzione («Notes for Claude»). */
const notesOf = new Map<string, string>();
/** Le guide in corso (per i test: `whenFixesIdle`). */
const running = new Set<Promise<void>>();
onStoreReset(() => {
  turns.clear();
  planned.clear();
  notesOf.clear();
  running.clear();
});

const take = (id: string): number => {
  const n = (turns.get(id) ?? 0) + 1;
  turns.set(id, n);
  return n;
};
/** Nessuna guida di prima scrive più in questa sessione. */
const halt = (id: string): void => void take(id);

/** Si risolve quando ogni correzione in corso è arrivata a uno stato fermo (per i test). */
export async function whenFixesIdle(): Promise<void> {
  while (running.size > 0) await Promise.all([...running]);
}

function track(c: Conversation, gen: number, work: Promise<void>): void {
  const done: Promise<void> = work
    .catch((e: unknown) => failFix(c, gen, e))
    .finally(() => running.delete(done));
  running.add(done);
}

const serverOf = (code: string) => state.servers.find((s) => s.code === code);

/** I motivi dell'episodio della task (vuoti se la task non ne ha uno). */
function reasonsOf(task: Task): EpisodeReason[] {
  const id = task.serverRef?.episodeId;
  return state.serverEpisodes.find((e) => e.id === id)?.reasons ?? [];
}

/**
 * I progetti che usano il server ADESSO, coi container dei loro ambienti
 * (R0-D): il piano si valida contro di loro (`validateServerPlan`), così un
 * passo tocca solo un container del progetto della task e di nessun altro.
 */
function serverProjectsNow(code: string): AttributionInput["serverProjects"] {
  const codeOf = (id: string) => state.projectsById.get(id)?.code ?? id;
  return serverProjectsOf(code, liveEnvironments(), codeOf);
}

const isLive = (c: Conversation | undefined): boolean => c !== undefined && c.state !== "finished";

/**
 * Il piano che aspetta l'approvazione sta ancora nelle regole di adesso
 * (F4b: il piano si rivalida all'approvazione, `plan_stale`): ogni
 * container ancora riportato dall'agente e non legato a un altro progetto.
 */
export function serverPlanStillFits(c: Conversation): boolean {
  const plan = planned.get(c.id);
  const server = c.serverFix ? serverOf(c.serverFix.serverCode) : undefined;
  if (!plan || !server || c.projectId === null) return false;
  return validateServerPlan({
    plan,
    projectId: c.projectId,
    serverProjects: serverProjectsNow(server.code),
    seenContainers: docker(server).map((x) => x.name),
  }).ok;
}

// --- l'avvio ------------------------------------------------------------------

/**
 * «Avvia la correzione sul server»: prima di tutto `servers.operate` nel
 * progetto della task (`forbidden`, nessuna sessione); poi la task, il
 * server e le operazioni dell'agente (`fixStartBlock` → `invalid: <motivo>`).
 * Apre una sessione `task_run` con `serverFix`; Claude guarda i container
 * con le letture dell'agente, scrive il piano e si ferma:
 * `awaiting_approval`, sempre.
 */
export async function startServerFix(
  taskId: string,
  opts: { notes?: string } = {},
): Promise<Conversation> {
  const gen = storeGeneration();
  const me = await writer("startServerFix");
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) throw notFound();
  if (!can(viewerFor(me), "servers.operate", task.projectId)) throw forbidden();
  // La task, il server ancora del suo progetto (R-L2, R-G5), il lavoro vivo, le operazioni.
  const block = serverFixStartBlock(me, task);
  // Le parole del server (F4b): una correzione già viva sulla task o sul
  // server è `fix_busy`; il resto col suo motivo.
  if (block) throw invalid(block === "run_live" || block === "server_busy" ? "fix_busy" : block);
  const server = serverOf(task.serverRef!.serverCode);
  if (!server) throw invalid("server_gone");
  // Area 9b: col budget esaurito è rifiutata, con la coda in pausa aspetta.
  const aiBlock = aiStartBlock(me, task.projectId);
  const c = openWorkConversationAs(me, {
    kind: "task_run",
    ...runIdentity("fix_plan", task.projectId),
    title: `Fix ${server.code} · ${task.title}`,
    projectId: task.projectId,
    taskId: task.id,
    state: "working",
    serverFix: { serverCode: server.code },
  });
  task.claude = "working";
  // «Notes for Claude» (facoltative): restano per ogni piano di questa sessione.
  const notes = opts.notes?.trim();
  if (notes) notesOf.set(c.id, notes);
  await startOrHold(me, c, "server_fix", aiBlock, gen, async () => {
    await runScript(
      c.id,
      [
        { step: "event", event: { type: "phase", phase: "plan", outcome: null } },
        { step: "state", state: "working" },
      ],
      gen,
    );
    track(c, gen, writePlan(c, task, gen));
  });
  return copy(c);
}

/**
 * Claude rilegge i container (letture dell'AGENTE, una alla volta,
 * ricontrollate prima di ognuna) e scrive il piano di azioni dell'insieme
 * chiuso, poi aspetta: il piano arriva `pending`, sempre. Se nessuna azione
 * ammessa serve, lo dice e chiude senza piano. `instructions`: quelle di chi
 * ha rifiutato il piano di prima (o di «Ferma e scrivi»).
 */
async function writePlan(
  c: Conversation,
  task: Task,
  gen: number,
  instructions?: string,
): Promise<void> {
  const mine = take(c.id);
  const go = () => gen === storeGeneration() && turns.get(c.id) === mine && isLive(c);
  const code = c.serverFix!.serverCode;
  const server = serverOf(code);
  if (!server) throw new Error("server not found");
  const proposal = fixPlan(
    server,
    reasonsOf(task),
    task.description,
    { projectId: task.projectId, serverProjects: serverProjectsNow(code) },
    instructions,
    notesOf.get(c.id),
  );
  await runScript(
    c.id,
    [
      { step: "state", state: "working" },
      {
        step: "say",
        text: instructions
          ? `Understood. I am looking at ${server.code} again and rewriting the plan with your instructions.`
          : `I am looking at the containers on ${server.code} through the monitoring agent before writing the plan.`,
      },
    ],
    gen,
  );
  // R1: tolto il server dal progetto della task, Claude non lo legge più
  // per conto di quel progetto e non scrive il piano: si ferma col motivo.
  const block = () => serverFixBlock(c);
  for (const r of proposal.reads) {
    if (!go()) break;
    const b = block();
    if (b) return stopFix(c, gen, b);
    await runScript(c.id, () => (go() && !block() ? readSteps([r]) : []), gen);
  }
  if (go()) {
    const b = block();
    if (b) return stopFix(c, gen, b);
  }
  const project = state.projectsById.get(task.projectId)!.code;
  let blockedAtPlan: ReturnType<typeof block> = null;
  await runScript(
    c.id,
    () => {
      if (!go()) return [];
      blockedAtPlan = block();
      if (blockedAtPlan) return [];
      if (!proposal.plan) {
        planned.delete(c.id);
        return [
          {
            step: "say",
            text: `None of the actions Stubwise allows (restart, stop or start a container, free up space) fixes this on ${server.code}, so there is no plan. ${task.code} stays open: the fix, if any, is in the code.`,
          },
          {
            step: "event",
            event: {
              type: "phase",
              phase: "plan",
              outcome: "ok",
              ...(proposal.error ? { planError: proposal.error } : {}),
            },
          },
          { step: "state", state: "finished", outcome: "ok" },
        ];
      }
      planned.set(c.id, proposal.plan);
      return [
        { step: "say", text: `I have looked at ${server.code}. Here is the plan.` },
        {
          step: "event",
          event: {
            type: "plan",
            planText: proposal.planText,
            summary: proposal.summary,
            serverPlan: proposal.plan,
            status: "pending",
          },
        },
        {
          step: "say",
          text: `Nothing runs on ${server.code} until someone who can approve plans in ${project} approves it.`,
        },
        { step: "state", state: "awaiting_approval" },
      ];
    },
    gen,
  );
  if (blockedAtPlan && go()) await stopFix(c, gen, blockedAtPlan);
}

/** Il piano rifiutato con indicazioni (o un «Ferma e scrivi»): Claude lo riscrive, di nuovo da approvare. */
export function replanServerFix(
  c: Conversation,
  task: Task,
  instructions: string | undefined,
  gen: number,
): void {
  track(c, gen, writePlan(c, task, gen, instructions));
}

// --- l'esecuzione ---------------------------------------------------------------

type PlanEvent = Extract<ReturnType<typeof eventsOf>[number], { type: "plan" }>;

/**
 * Il piano è approvato da una persona (`decidePlan`): l'agente esegue le
 * azioni di QUEL piano, una alla volta, poi Claude controlla e chiude la
 * sessione. Prima di ogni azione: nessuno l'ha fermata, il server è ancora
 * del progetto, le operazioni sono accese.
 */
export function executeServerFix(c: Conversation, task: Task, gen: number): void {
  track(c, gen, execute(c, task, gen));
}

async function execute(c: Conversation, task: Task, gen: number): Promise<void> {
  const mine = take(c.id);
  const go = () => gen === storeGeneration() && turns.get(c.id) === mine && isLive(c);
  const code = c.serverFix!.serverCode;
  const server = serverOf(code);
  if (!server) throw new Error("server not found");
  const plan = planned.get(c.id);
  // L'approvazione che copre i comandi: l'evento del piano approvato.
  const approval = eventsOf(c.id)
    .filter((e): e is PlanEvent => e.type === "plan")
    .at(-1);
  if (!plan || approval?.status !== "approved") throw new Error("no approved plan");
  await runScript(
    c.id,
    [
      { step: "event", event: { type: "phase", phase: "plan", outcome: "ok" } },
      { step: "event", event: { type: "phase", phase: "execution", outcome: null } },
      { step: "state", state: "working" },
      {
        step: "say",
        text: `Plan approved. The monitoring agent on ${server.code} runs the actions, one at a time.`,
      },
    ],
    gen,
  );
  for (const step of plan.steps) {
    if (!go()) return;
    const blocked = serverFixBlock(c);
    if (blocked) return stopFix(c, gen, blocked);
    // L'azione entra solo se, al suo turno nella coda, nessuno ha fermato la
    // sessione, il server è ancora del progetto e le operazioni sono accese.
    await runScript(
      c.id,
      () => (!go() || serverFixBlock(c) ? [] : [fixStepAction(step, approval.id)]),
      gen,
    );
  }
  if (!go()) return;
  // Il controllo legge via agente: anche lui vuole il server del progetto e
  // le operazioni accese.
  const blockedAtCheck = serverFixBlock(c);
  if (blockedAtCheck) return stopFix(c, gen, blockedAtCheck);
  const resolved = (state.fixCheckNext.get(code) ?? "resolved") === "resolved";
  state.fixCheckNext.delete(code);
  await runScript(
    c.id,
    () => {
      if (!go() || serverFixBlock(c)) return [];
      return [
        {
          step: "say",
          text: `The actions are done. Checking ${server.code} through the agent.`,
        },
        ...fixCheck(server, plan, reasonsOf(task), resolved),
        {
          step: "say",
          text: resolved
            ? `The problem is gone. ${task.code} stays open: close it when you have seen it.`
            : `The problem is still there. ${task.code} stays open.`,
        },
        { step: "event", event: { type: "phase", phase: "execution", outcome: "ok" } },
        { step: "state", state: "finished", outcome: "ok" },
      ] as ScriptStep[];
    },
    gen,
  );
}

// --- fermarsi ------------------------------------------------------------------

const phaseNow = (c: Conversation) => currentPhase(eventsOf(c.id)) ?? "execution";

type StopReason = "operations_off" | "server_gone";

const STOP_WHY: Record<StopReason, string> = {
  operations_off: "the agent's operations were turned off",
  server_gone: "the server isn't in this project any more",
};

/** Ferma la sessione senza una persona: operazioni spente, server tolto dal progetto. */
function stopFix(c: Conversation, gen: number, reason: StopReason): Promise<void> {
  halt(c.id);
  interruptScripts(c.id, i18n.t("claude.conversation.delivery.stoppedBeforeTurn"));
  const why = STOP_WHY[reason];
  return runScript(
    c.id,
    () => [
      { step: "finish_action", outcome: "failed", result: "Stopped" },
      { step: "say", text: `I stopped: ${why}. No actions after this.` },
      {
        step: "event",
        event: {
          type: "phase",
          phase: phaseNow(c),
          outcome: "stopped",
          reason: reason === "server_gone" ? reason : "operations_off",
        },
      },
      { step: "state", state: "finished", outcome: "stopped" },
    ],
    gen,
  );
}

/**
 * Lo «Stop» di una persona (`canInterrupt`): la sessione si chiude fermata
 * da lei («Fix stopped by …»), nessuna azione dopo (le non partite non si
 * consegnano all'agente). Non va in pausa: una
 * correzione non riprende da sola, si riavvia (e il piano si riapprova).
 */
export function stopServerFixAs(me: string, c: Conversation, gen: number): Promise<void> {
  halt(c.id);
  interruptScripts(c.id, i18n.t("claude.conversation.delivery.stoppedBeforeTurn"));
  return runScript(
    c.id,
    () => [
      { step: "finish_action", outcome: "failed", result: "Stopped" },
      {
        step: "event",
        event: { type: "phase", phase: phaseNow(c), outcome: "stopped", stoppedById: me },
      },
      { step: "state", state: "finished", outcome: "stopped" },
    ],
    gen,
  );
}

/**
 * «Ferma e scrivi» su una correzione: si ferma come uno Stop (nessuna
 * azione dopo) e Claude riscrive il piano dal messaggio — di nuovo da
 * approvare, mai un'esecuzione che riparte da sola.
 */
export async function stopAndReplanServerFixAs(
  me: string,
  c: Conversation,
  task: Task,
  text: string,
  gen: number,
): Promise<void> {
  halt(c.id);
  interruptScripts(c.id, i18n.t("claude.conversation.delivery.stoppedBeforeTurn"));
  await runScript(
    c.id,
    () => [
      { step: "finish_action", outcome: "failed", result: "Stopped" },
      {
        step: "event",
        event: { type: "phase", phase: phaseNow(c), outcome: "stopped", stoppedById: me },
      },
      { step: "event", event: { type: "phase", phase: "plan", outcome: null } },
      {
        step: "event",
        event: { type: "user", authorId: me, text, attachments: [], delivery: "delivered" },
      },
    ],
    gen,
  );
  replanServerFix(c, task, text, gen);
}

/** Un errore a metà: la sessione si chiude `failed` e lo dice; mai viva per sempre. */
async function failFix(c: Conversation, gen: number, e: unknown): Promise<void> {
  if (gen !== storeGeneration() || !isLive(c)) return;
  halt(c.id);
  const reason = e instanceof Error ? e.message : String(e);
  c.failureSummary = `The fix stopped on an error: ${reason}`;
  notifyConversationChange(c.id);
  await runScript(
    c.id,
    () => [
      { step: "finish_action", outcome: "failed" },
      { step: "say", text: `I stopped on an error (${reason}). No actions after this.` },
      { step: "event", event: { type: "phase", phase: phaseNow(c), outcome: "failed" } },
      { step: "state", state: "finished", outcome: "failed" },
    ],
    gen,
  );
}
