import { accessUsable } from "../../domain/servers/sshAccess";
import i18n from "../../i18n";
import { openWorkConversationAs } from "../api-mutations";
import { TEAM_ACCOUNT } from "../seed/runs";
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
import { markUsed, onAccessRevoked } from "./access";
import { hasKey } from "./secrets";
import { fixCheck, fixExecution, fixPlan, type FixCommand } from "./fixScripts";
import { readSteps } from "./scripts";
import { serverFixStartBlock } from "./visibility";

// La correzione di un server, avviata da una task (area 8b, anti-obiettivo
// 2). Due condizioni, sempre:
// 1. parte solo da una task legata a QUEL server (`serverRef`), avviata da
//    chi ha `servers.operate` nel progetto della task — Claude non l'ha mai
//    (R-L9), quindi la avvia sempre una persona;
// 2. nessun comando di correzione (`tool: "server.fix"`) precede un piano
//    approvato da una persona con `plans.approve` (R-L11: mai Claude) —
//    anche se chi avvia può approvare: il piano arriva SEMPRE da approvare
//    (`planGateFor`), niente approvazione in anticipo né «parte subito».
//
// Il resto sta qui: il piano scritto dopo aver letto il server con
// l'accesso di LETTURA, l'esecuzione dopo l'approvazione (un comando alla
// volta, ricontrollando prima di ognuno che il server sia ancora in un
// ambiente del progetto della task — R-L2, R-G5 —, che l'accesso di
// correzione sia usabile e che nessuno l'abbia fermata), il controllo
// finale in sola lettura (`resolved` esplicito, R-L3), e i modi di
// fermarsi — ognuno col suo segno nel flusso: lo Stop di una persona
// (`stoppedById`), la revoca (`reason: "fix_access_revoked"`), l'accesso
// non più usabile (`fix_access_unusable`), il server tolto dal progetto
// (`server_gone`), un errore (`outcome: "failed"`).
//
// Dopo il controllo finale la sessione si chiude SEMPRE (stesso script):
// il controllo è l'ultima cosa che fa. La task resta aperta: la chiude una
// persona.

/**
 * Per sessione: il turno di chi la guida. Ogni guida (piano, esecuzione)
 * prende un turno; uno Stop o una revoca lo cambiano SUBITO, così la guida
 * di prima non accoda più niente — nemmeno un comando già deciso.
 */
const turns = new Map<string, number>();
/** Per sessione: i comandi dell'ultimo piano scritto, cioè quelli che si approvano. */
const planned = new Map<string, FixCommand[]>();
/** Le guide in corso (per i test: `whenFixesIdle`). */
const running = new Set<Promise<void>>();
onStoreReset(() => {
  turns.clear();
  planned.clear();
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
 * Perché la correzione non può eseguire il prossimo comando (`null` se può):
 * la regola dell'approvazione (`serverFixBlock`: server ancora del
 * progetto, accesso usabile) e in più la chiave, che qui c'è da usare.
 */
function execBlock(c: Conversation): StopReason | null {
  const block = serverFixBlock(c);
  if (block === "server_gone") return "server_gone";
  if (block === "fix_access_revoked") return "fix_access_revoked";
  if (block !== null || !hasKey(c.serverFix!.serverCode, "fix")) return "fix_access_unusable";
  return null;
}

const readUsable = (code: string): boolean => accessUsable(state.serverAccess.get(code), "read");

const isLive = (c: Conversation | undefined): boolean => c !== undefined && c.state !== "finished";

// --- l'avvio ------------------------------------------------------------------

/**
 * «Avvia la correzione sul server»: prima di tutto `servers.operate` nel
 * progetto della task (`forbidden`, nessuna sessione); poi la task e
 * l'accesso (`fixStartBlock` → `invalid: <motivo>`). Apre una sessione
 * `task_run` con `serverFix`; Claude legge il server in sola lettura,
 * scrive il piano e si ferma: `awaiting_approval`, sempre.
 */
export async function startServerFix(taskId: string): Promise<Conversation> {
  const gen = storeGeneration();
  const me = await writer("startServerFix");
  const task = state.tasksById.get(taskId);
  if (!task || !visibleProjectIds(me).has(task.projectId)) throw notFound();
  if (!can(viewerFor(me), "servers.operate", task.projectId)) throw forbidden();
  // La task, il server ancora del suo progetto (R-L2, R-G5), il lavoro vivo, l'accesso.
  const block = serverFixStartBlock(me, task);
  if (block) throw invalid(block);
  const server = serverOf(task.serverRef!.serverCode);
  if (!server) throw invalid("server_gone");
  const c = openWorkConversationAs(me, {
    kind: "task_run",
    provider: { ...TEAM_ACCOUNT },
    title: `Fix ${server.code} · ${task.title}`,
    projectId: task.projectId,
    taskId: task.id,
    state: "working",
    serverFix: { serverCode: server.code },
  });
  task.claude = "working";
  await runScript(
    c.id,
    [
      { step: "event", event: { type: "phase", phase: "plan", outcome: null } },
      { step: "state", state: "working" },
    ],
    gen,
  );
  track(c, gen, writePlan(c, task, gen));
  return copy(c);
}

/**
 * Claude rilegge il server (accesso di LETTURA, una lettura alla volta,
 * ricontrollato prima di ognuna) e scrive il piano coi comandi previsti,
 * poi aspetta: il piano arriva `pending`, sempre. `instructions`: quelle di
 * chi ha rifiutato il piano di prima (o di «Ferma e scrivi»).
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
  const plan = fixPlan(server, reasonsOf(task), task.description, instructions);
  await runScript(
    c.id,
    [
      { step: "state", state: "working" },
      {
        step: "say",
        text: instructions
          ? `Understood. I am reading ${server.code} again and rewriting the plan with your instructions.`
          : `I am reading ${server.code} with the read-only access before writing the plan.`,
      },
    ],
    gen,
  );
  // R1: tolto il server dal progetto della task, Claude non lo legge più
  // per conto di quel progetto e non scrive il piano: si ferma col motivo.
  const gone = () => serverFixBlock(c) === "server_gone";
  let reads = 0;
  for (const r of plan.reads) {
    if (!go()) break;
    if (gone()) return stopFix(c, gen, "server_gone");
    if (!readUsable(code)) break;
    if (reads === 0) markUsed(code, "read", { kind: "task", taskId: task.id });
    reads++;
    await runScript(c.id, () => (go() && !gone() ? readSteps([r]) : []), gen);
  }
  if (go() && gone()) return stopFix(c, gen, "server_gone");
  const project = state.projectsById.get(task.projectId)!.code;
  let goneAtPlan = false;
  await runScript(
    c.id,
    () => {
      if (!go()) return [];
      if (gone()) {
        goneAtPlan = true;
        return [];
      }
      planned.set(c.id, plan.commands);
      return [
        {
          step: "say",
          text:
            reads > 0
              ? `I have read ${server.code}. Here is the plan.`
              : `I couldn't read ${server.code} with the read-only access: the plan comes from the diagnosis in ${task.code}.`,
        },
        {
          step: "event",
          event: {
            type: "plan",
            planText: plan.planText,
            summary: plan.summary,
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
  if (goneAtPlan && go()) await stopFix(c, gen, "server_gone");
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

/**
 * Il piano è approvato da una persona (`decidePlan`): Claude esegue i
 * comandi di QUEL piano con l'accesso di correzione, uno alla volta, poi
 * controlla in sola lettura e chiude la sessione. Prima di ogni comando:
 * nessuno l'ha fermata, l'accesso di correzione è usabile.
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
  await runScript(
    c.id,
    [
      { step: "event", event: { type: "phase", phase: "plan", outcome: "ok" } },
      { step: "event", event: { type: "phase", phase: "execution", outcome: null } },
      { step: "state", state: "working" },
      {
        step: "say",
        text: `Plan approved. Running the commands on ${server.code} as stubwise-fix.`,
      },
    ],
    gen,
  );
  let ran = 0;
  for (const step of fixExecution(planned.get(c.id) ?? [])) {
    if (!go()) return;
    const blocked = execBlock(c);
    if (blocked) return stopFix(c, gen, blocked);
    // Il comando entra solo se, al suo turno nella coda, nessuno ha fermato
    // la sessione, il server è ancora del progetto e l'accesso è usabile.
    await runScript(
      c.id,
      () => {
        if (!go() || execBlock(c)) return [];
        if (ran === 0) markUsed(code, "fix", { kind: "task", taskId: task.id });
        ran++;
        return [step];
      },
      gen,
    );
  }
  if (!go()) return;
  const resolved = (state.fixCheckNext.get(code) ?? "resolved") === "resolved";
  state.fixCheckNext.delete(code);
  const readable = readUsable(code);
  await runScript(
    c.id,
    () => {
      if (!go()) return [];
      if (readable) markUsed(code, "read", { kind: "task", taskId: task.id });
      return [
        {
          step: "say",
          text: `The commands are done. Checking ${server.code} with the read-only access.`,
        },
        ...(readable
          ? fixCheck(reasonsOf(task), resolved)
          : ([
              {
                step: "say",
                text: `I can't check ${server.code}: the read-only access isn't usable.`,
              },
            ] as ScriptStep[])),
        ...(readable
          ? ([
              {
                step: "say",
                text: resolved
                  ? `The problem is gone. ${task.code} stays open: close it when you have seen it.`
                  : `The problem is still there. ${task.code} stays open.`,
              },
            ] as ScriptStep[])
          : []),
        { step: "event", event: { type: "phase", phase: "execution", outcome: "ok" } },
        { step: "state", state: "finished", outcome: "ok" },
      ];
    },
    gen,
  );
}

// --- fermarsi ------------------------------------------------------------------

const phaseNow = (c: Conversation) => currentPhase(eventsOf(c.id)) ?? "execution";

type StopReason = "fix_access_revoked" | "fix_access_unusable" | "server_gone";

const STOP_WHY: Record<StopReason, string> = {
  fix_access_revoked: "the fix access was revoked",
  fix_access_unusable: "the fix access isn't usable any more",
  server_gone: "the server isn't in this project any more",
};

/** Ferma la sessione senza una persona: revoca, accesso non più usabile, server tolto dal progetto. */
function stopFix(c: Conversation, gen: number, reason: StopReason): Promise<void> {
  halt(c.id);
  interruptScripts(c.id, i18n.t("claude.conversation.delivery.stoppedBeforeTurn"));
  const why = STOP_WHY[reason];
  return runScript(
    c.id,
    () => [
      { step: "finish_action", outcome: "failed", result: "Stopped" },
      { step: "say", text: `I stopped: ${why}. No commands after this.` },
      { step: "event", event: { type: "phase", phase: phaseNow(c), outcome: "stopped", reason } },
      { step: "state", state: "finished", outcome: "stopped" },
    ],
    gen,
  );
}

// Una revoca ferma subito la correzione viva su quel server, mentre legge
// o esegue. Quella che aspetta l'approvazione resta ferma lì: l'approvazione
// si spegne (`planBlockedReason`) e il rifiuto resta possibile. Il gancio
// resta iscritto anche dopo `resetApi` (vedi `onAccessRevoked`).
onAccessRevoked((code) => {
  const gen = storeGeneration();
  for (const c of state.conversations) {
    if (c.serverFix?.serverCode !== code || !isLive(c) || c.state === "awaiting_approval") continue;
    track(c, gen, stopFix(c, gen, "fix_access_revoked"));
  }
});

/**
 * Lo «Stop» di una persona (`canInterrupt`): la sessione si chiude fermata
 * da lei («Fix stopped by …»), nessun comando dopo. Non va in pausa: una
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
 * «Ferma e scrivi» su una correzione: si ferma come uno Stop (nessun
 * comando dopo) e Claude riscrive il piano dal messaggio — di nuovo da
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
      { step: "say", text: `I stopped on an error (${reason}). No commands after this.` },
      { step: "event", event: { type: "phase", phase: phaseNow(c), outcome: "failed" } },
      { step: "state", state: "finished", outcome: "failed" },
    ],
    gen,
  );
}
