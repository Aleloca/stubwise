import { attributeServerCause } from "@stubwise/shared";
import { ANALYSIS_MAX_COST_USD, ANALYSIS_MAX_MINUTES } from "../../domain/servers/limits";
import { alertProjectsOf, serverProjectsOf } from "../../domain/servers/projects";
import { commandInput } from "../../domain/servers/commands";
import { accessState, accessUsable, journalReadable } from "../../domain/servers/sshAccess";
import { utterance } from "../../domain/claude/answers";
import i18n from "../../i18n";
import { publishAlert } from "../alerts/publish";
import { createTaskAs, openWorkConversationAs, runIdentity } from "../api-mutations";
import { aiBlockFor } from "../instance/blocks";
import { CLAUDE_ID } from "../seed/people";
import { newId, now, onStoreReset, state, storeGeneration } from "../store";
import { interruptScripts, notifyConversationChange, runScript } from "../stream";
import type {
  EpisodeReason,
  ModelUsage,
  MonitoredServer,
  Outcome,
  ScriptStep,
  ServerAnalysis,
  ServerAttribution,
  ServerEpisode,
  Task,
} from "../types";
import { PEOPLE } from "../seed/people";
import { invalid, notFound } from "../writer";
import { markUsed, onAccessRevoked } from "./access";
import {
  declaredCauseOf,
  diagnosisOf,
  docker,
  lookDiagnosisOf,
  lookReasons,
  openingSteps,
  readsFor,
  readSteps,
  reasonsPhrase,
  unavailableOf,
  unavailableSteps,
  type ReadReach,
  type UnavailableRead,
} from "./scripts";
import { liveEnvironments, serverHref } from "./visibility";

// Gli episodi dei server e l'analisi automatica (area 8b, solo prototipo:
// gli allarmi e i rientri li porta l'agente di monitoraggio, qui li fanno
// arrivare i «Simula …»).
//
// Un allarme apre un EPISODIO; un secondo allarme mentre l'episodio è
// aperto aggiunge i suoi motivi e basta — nessun avviso nuovo, nessuna
// analisi nuova: quella in corso li legge (le letture si calcolano a ogni
// giro dai motivi di adesso), e la diagnosi li nomina tutti; ad analisi
// finita, la task lo registra in fondo.
//
// Gli avvisi vanno ai progetti la cui PRODUZIONE usa il server (R-L2,
// `alertProjectsOf`). L'analisi è del SERVER (area 8, F4b-4): nessun
// progetto scelto prima, nessun «progetto principale»; parte all'allarme se
// una produzione usa il server, nel budget mensile dell'ISTANZA (la pausa
// della coda di un progetto non la ferma: non è di un progetto), a nome di
// Claude e solo con l'accesso di LETTURA usabile (`accessUsable`, mai il solo
// stato, ricontrollato prima di ogni lettura): sola lettura vera. Legge solo
// dagli insiemi chiusi (F4b): le letture SSH di `SSH_READS` (il journal solo
// col gruppo, F4b-3) e, con le operazioni dell'agente accese, i log e lo
// stato dei container via agente; ciò che non può leggere lo dice.
//
// È lei a dire QUALE progetto è la causa: la causa dichiarata
// (`declaredCauseOf`, contenuto del modello, non fidato) si valida con
// `attributeServerCause` di `@stubwise/shared` contro i progetti del server
// e i container legati ai loro ambienti. Attribuita, la task nasce in QUEL
// progetto (anche col server irraggiungibile, al limite di tempo, rientrato
// prima di guardare o con l'accesso perso a metà, con ciò che ha visto); se
// la task non si apre, finisce `failed` e lo dice — mai `running` per
// sempre. Non determinata: nessuna task, nessuna proposta; la diagnosi resta
// sull'analisi (la legge chi gestisce il monitor) e l'avviso lo dice.
//
// Tutto il seguito fissa la generazione dello stato quando parte: dopo un
// `resetApi` nessuna analisi scrive nello stato nuovo.

/** I tentativi di connessione prima di dire il server irraggiungibile. */
const ATTEMPTS = 3;

/** Le analisi in corso nella sessione: id dell'analisi → la sua fine. */
const runs = new Map<string, Promise<void>>();
onStoreReset(() => runs.clear());

/** Si risolve quando ogni analisi in corso è finita (per i test e per «Simula»). */
export async function whenAnalysesIdle(): Promise<void> {
  while (runs.size > 0) await Promise.all([...runs.values()]);
}

const sameReason = (a: EpisodeReason, b: EpisodeReason): boolean =>
  a.kind === b.kind && (a.kind !== "check" || (b.kind === "check" && a.checkId === b.checkId));

const serverOf = (code: string): MonitoredServer | undefined =>
  state.servers.find((s) => s.code === code);

const projectCode = (projectId: string) => state.projectsById.get(projectId)!.code;

/** Che cosa l'analisi può leggere adesso: il journal (col gruppo) e i container (con l'agente). */
const reachOf = (s: MonitoredServer): ReadReach => ({
  journal: journalReadable(state.serverAccess.get(s.code)),
  agent: s.agentOperations,
});

/** L'analisi in corso su un server, se c'è. */
const runningOn = (code: string): ServerAnalysis | undefined =>
  state.serverAnalyses.find((a) => a.serverCode === code && a.outcome === "running");

// Una revoca ferma subito l'analisi in corso: la lettura a metà non finisce,
// e il giro successivo trova l'accesso non più usabile. Una «lettura che
// scrive» la ferma alla lettura successiva (ogni lettura ricontrolla).
// Il gancio resta iscritto anche dopo `resetApi` (vedi `onAccessRevoked`).
onAccessRevoked((code) => {
  const a = runningOn(code);
  if (a) interruptScripts(a.conversationId);
});

/** Quanto è durato un episodio, in parole (senza ora: l'ora la legge chi guarda nel suo fuso). */
function durationOf(ep: ServerEpisode): string {
  if (ep.recoveredAt === null) return "";
  const minutes = Math.round((Date.parse(ep.recoveredAt) - Date.parse(ep.startedAt)) / 60_000);
  if (minutes < 1) return "";
  if (minutes < 120) return ` after ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return ` after ${Math.round(minutes / 60)} h`;
}

/**
 * La riga del rientro nella task. Niente ora scritta nel testo: il testo è
 * lo stesso per tutti, l'ora no (fuso di chi guarda). L'ora vera sta
 * nell'episodio (`recoveredAt`, da `serverRef.episodeId`) e la UI la mostra
 * formattata per chi guarda.
 */
const recoveredLine = (ep: ServerEpisode): string =>
  `**Back to normal**${durationOf(ep)}, without any change from Stubwise.`;

// --- gli avvisi ---------------------------------------------------------------

/** Perché Claude non guarda: nessun accesso, o un accesso di lettura non usabile. */
function noAnalysisTail(code: string): string {
  const s = accessState(state.serverAccess.get(code));
  return s === "not_linked" || s === "revoked"
    ? "Claude can't look into it: no SSH access."
    : "Claude can't look into it: the read-only SSH access isn't usable.";
}

/**
 * La coda dell'avviso: cosa fa Claude adesso. Col budget raggiunto non
 * parte (revisione finale M4): l'avviso non dice «is looking into it» quando
 * non è vero.
 */
function publishTrouble(s: MonitoredServer, ep: ServerEpisode, analyzes: boolean): void {
  const readable = accessUsable(state.serverAccess.get(s.code));
  const tail = analyzes
    ? " Claude is looking into it with read-only access."
    : !readable
      ? ` ${noAnalysisTail(s.code)}`
      : ep.analysisBlocked === "monthly_budget"
        ? " Claude can't look into it: the monthly AI budget is used up."
        : "";
  for (const to of alertProjectsOf(s.code, liveEnvironments())) {
    publishAlert({
      kind: ep.severity === "down" ? "server.down" : "server.trouble",
      projectId: to,
      objectCode: s.code,
      title: ep.severity === "down" ? "Server not responding" : "Server in trouble",
      body: `${s.name}: ${reasonsPhrase(ep.reasons)}.${tail}`,
      link: serverHref(projectCode(to), s.code),
    });
  }
}

// --- l'episodio ---------------------------------------------------------------

/**
 * Un allarme del server. Con un episodio aperto aggiunge i motivi nuovi (e
 * passa a `down` se serve) senza avvisi né analisi nuovi. Altrimenti apre
 * l'episodio, avvisa le produzioni che usano il server e, con l'accesso di
 * lettura usabile, almeno una produzione e il budget dell'istanza, fa
 * partire l'analisi del server.
 */
export function raiseEpisode(
  serverCode: string,
  reasons: EpisodeReason[],
  severity: ServerEpisode["severity"],
  opts: { overrun?: boolean } = {},
): ServerEpisode {
  const server = serverOf(serverCode);
  if (!server) throw notFound();
  const open = state.serverEpisodes.find(
    (e) => e.serverCode === serverCode && e.recoveredAt === null,
  );
  if (open) {
    const added = reasons.filter((r) => !open.reasons.some((x) => sameReason(x, r)));
    open.reasons.push(...structuredClone(added));
    const escalated = severity === "down" && open.severity !== "down";
    if (escalated) open.severity = "down";
    if (added.length > 0 || escalated) noteOnFinishedTask(open, added, escalated);
    return open;
  }
  const episode: ServerEpisode = {
    id: newId("ep"),
    serverCode,
    severity,
    reasons: structuredClone(reasons),
    startedAt: now(),
    recoveredAt: null,
    analysisId: null,
  };
  state.serverEpisodes.push(episode);
  // Solo con una produzione (un server di solo staging non avvisa e non si
  // analizza) e l'accesso di lettura usabile. Il budget è dell'istanza
  // (`aiBlockFor(null)`: nessuna pausa di progetto, F4b-4): esaurito,
  // l'analisi non parte e l'episodio lo ricorda (area 9b).
  const eligible =
    alertProjectsOf(serverCode, liveEnvironments()).length > 0 &&
    accessUsable(state.serverAccess.get(serverCode));
  const block = aiBlockFor(null);
  const analyzes = eligible && block === null;
  if (eligible && block?.reason === "monthly_budget") episode.analysisBlocked = "monthly_budget";
  publishTrouble(server, episode, analyzes);
  if (analyzes) startAnalysis(server, episode, opts.overrun === true);
  return episode;
}

/**
 * Un allarme in più su un episodio la cui analisi è già finita: nessun
 * avviso e nessuna analisi nuovi, ma la task lo registra in fondo — così il
 * motivo nuovo non sparisce. Un'analisi in corso invece li legge da sé.
 */
function noteOnFinishedTask(ep: ServerEpisode, added: EpisodeReason[], escalated: boolean): void {
  const analysis = state.serverAnalyses.find((a) => a.id === ep.analysisId);
  if (!analysis?.taskId || analysis.outcome === "running") return;
  const task = state.tasksById.get(analysis.taskId);
  if (!task) return;
  const what = [
    ...(added.length > 0 ? [reasonsPhrase(added)] : []),
    ...(escalated ? ["the server stopped responding"] : []),
  ].join("; ");
  task.description = `${task.description}\n\n**New alert** — ${what}. Claude didn't look into it again.`;
  task.lastActivityAt = now();
}

/**
 * Il server è rientrato: l'episodio si chiude e le produzioni lo sanno. Se
 * l'analisi è in corso finisce subito, e la task lo dice; se la task c'è
 * già, il rientro le si aggiunge in fondo. `null` senza episodio aperto.
 */
export function recoverEpisode(serverCode: string): ServerEpisode | null {
  const server = serverOf(serverCode);
  if (!server) throw notFound();
  const ep = state.serverEpisodes.find(
    (e) => e.serverCode === serverCode && e.recoveredAt === null,
  );
  if (!ep) return null;
  ep.recoveredAt = now();
  // Un agente muto che torna a rispondere ha appena riportato; uno mai
  // collegato resta senza rapporti (ri-revisione m2).
  if (server.lastSeenAt !== null && ep.reasons.some((r) => r.kind === "agent_silent"))
    server.lastSeenAt = now();
  for (const projectId of alertProjectsOf(serverCode, liveEnvironments())) {
    publishAlert({
      kind: "server.recovered",
      projectId,
      objectCode: serverCode,
      title: "Server back to normal",
      body: `${server.name} is back to normal${durationOf(ep)}.`,
      link: serverHref(projectCode(projectId), serverCode),
    });
  }
  const analysis = state.serverAnalyses.find((a) => a.id === ep.analysisId);
  if (analysis?.outcome === "running") {
    // Le letture rimaste non partono: l'analisi chiude con ciò che ha visto.
    interruptScripts(analysis.conversationId);
  } else if (analysis?.taskId) {
    const task = state.tasksById.get(analysis.taskId);
    if (task) {
      task.description = `${task.description}\n\n${recoveredLine(ep)}`;
      task.lastActivityAt = now();
    }
  }
  return ep;
}

// --- l'analisi ----------------------------------------------------------------

function startAnalysis(
  server: MonitoredServer,
  episode: ServerEpisode,
  overrun: boolean,
  startedBy: string | null = null,
): ServerAnalysis {
  const gen = storeGeneration();
  // Del server, non di un progetto (F4b-4): la sessione entra nel progetto
  // attribuito a fine analisi (`finish`); prima la vede chi gestisce il
  // monitor (`canSeeConversation`). L'account è quello della catena dell'istanza.
  const c = openWorkConversationAs(CLAUDE_ID, {
    kind: "server_analysis",
    ...runIdentity("fix_plan", null),
    title: `${server.code} ${server.name} · ${reasonsPhrase(episode.reasons)}`,
    projectId: null,
    touchedProjectIds: [],
    state: "working",
    usage: [],
    analysisLimits: { maxMinutes: ANALYSIS_MAX_MINUTES, maxCostUsd: ANALYSIS_MAX_COST_USD },
    serverAnalysis: { serverCode: server.code },
  });
  const analysis: ServerAnalysis = {
    id: newId("an"),
    serverCode: server.code,
    // Una a mano non è di un episodio (R0-A2): ne guarda una COPIA, mai salvata.
    episodeId: startedBy ? null : episode.id,
    startedBy,
    conversationId: c.id,
    attribution: null,
    outcome: "running",
    taskId: null,
    startedAt: now(),
    endedAt: null,
  };
  state.serverAnalyses.push(analysis);
  if (!startedBy) episode.analysisId = analysis.id;
  // Un errore (la task che non si apre) non lascia mai l'analisi `running`:
  // R-L6 bloccherebbe il server per sempre.
  const go = (): Promise<void> => {
    const done = drive(analysis, episode, gen, overrun)
      .catch((e: unknown) => failAnalysis(analysis, gen, e))
      .finally(() => {
        if (runs.get(analysis.id) === done) runs.delete(analysis.id);
      });
    runs.set(analysis.id, done);
    return done;
  };
  // Parte subito, nello stesso giro: il budget l'ha già guardato chi la avvia.
  void go();
  return analysis;
}

/**
 * Le cornici delle analisi a mano senza allarme: uno sguardo generale al
 * server (`lookReasons`), con la sua diagnosi (`lookDiagnosisOf`), non i
 * motivi di un episodio che non c'è.
 */
const looks = new WeakSet<ServerEpisode>();

/** Chi ha chiesto un'analisi a mano, per nome. */
const askedBy = (a: ServerAnalysis): string | null =>
  a.startedBy ? (PEOPLE.find((p) => p.id === a.startedBy)?.name ?? null) : null;

/**
 * «Ask Claude to look into it» (R0-A2): l'analisi a mano di un server, con
 * le stesse regole dell'automatica (sola lettura, tetti, budget
 * dell'istanza, attribuzione), ma da chiunque abbia `servers.operate` in un
 * progetto il cui ambiente usa il server — staging compreso. Chi la chiede
 * l'ha già passato (`startServerAnalysis` in `operate.ts`); qui: una già in
 * corso (`analysis_running`), l'accesso di lettura (`access`) e il budget.
 * Nessun episodio: con uno aperto guarda i suoi motivi (una copia), senza
 * uno sguardo generale.
 */
export function startManualAnalysis(server: MonitoredServer, me: string): ServerAnalysis {
  if (runningOn(server.code)) throw invalid("analysis_running");
  if (!accessUsable(state.serverAccess.get(server.code))) throw invalid("access");
  if (aiBlockFor(null)?.reason === "monthly_budget") throw invalid("monthly_budget");
  const open = state.serverEpisodes.find(
    (e) => e.serverCode === server.code && e.recoveredAt === null,
  );
  const frame: ServerEpisode = {
    id: newId("look"),
    serverCode: server.code,
    severity: open?.severity ?? "trouble",
    reasons: open ? structuredClone(open.reasons) : lookReasons(server),
    startedAt: now(),
    recoveredAt: null,
    analysisId: null,
  };
  if (!open) looks.add(frame);
  return startAnalysis(server, frame, false, me);
}

/** I tentativi di connessione a un server che non risponde: letture fallite. */
function unreachableSteps(s: MonitoredServer): ScriptStep[] {
  const host = s.hostname ?? s.name;
  return Array.from({ length: ATTEMPTS }, (_, i) => {
    const key = "claude.serverAnalysis.reads.attempt";
    const params = { n: i + 1 };
    const command = {
      action: "uptime",
      params: {},
      kind: "read",
      via: "ssh",
      approvalId: null,
      exitCode: 255,
    } as const;
    return {
      step: "action" as const,
      tool: "server.read",
      serverCommand: command,
      label: i18n.t(key, params),
      labelText: utterance(key, params),
      input: commandInput(command),
      result: `ssh: connect to host ${host} port 22: Connection timed out`,
      outcome: "failed" as const,
    };
  });
}

async function drive(
  a: ServerAnalysis,
  episode: ServerEpisode,
  gen: number,
  overrun: boolean,
): Promise<void> {
  const alive = () => gen === storeGeneration();
  let server = serverOf(a.serverCode);
  if (!server) return;
  await runScript(a.conversationId, openingOf(server, episode, a), gen);
  if (!alive()) return;
  if (!server.sshReachable) {
    await runScript(a.conversationId, unreachableSteps(server), gen);
    if (!alive()) return;
    return finish(a, episode, gen, "unreachable", 0);
  }
  const ran = new Set<string>();
  /** Ciò che non si legge, detto una volta sola (un secondo allarme può aggiungerne). */
  const told = new Set<UnavailableRead>();
  let ending: Ending = "diagnosed";
  // Una lettura alla volta, dai motivi di ADESSO: un secondo allarme durante
  // aggiunge le sue. Prima di ogni lettura si ricontrolla l'accesso (revoca,
  // lettura che scrive); il rientro ferma il giro.
  while (episode.recoveredAt === null) {
    server = serverOf(a.serverCode);
    if (!server) return;
    const reach = reachOf(server);
    const missing = unavailableOf(server, episode.reasons, reach).filter((m) => !told.has(m));
    if (missing.length > 0) {
      for (const m of missing) told.add(m);
      await runScript(a.conversationId, unavailableSteps(server, missing), gen);
      if (!alive()) return;
    }
    const all = readsFor(server, episode.reasons, reach);
    const next = all.find((r) => !ran.has(commandInput(r.command)));
    if (!next) break;
    // Al limite di tempo (solo «Simula»): metà delle letture, poi si ferma.
    if (overrun && ran.size >= Math.ceil(all.length / 2)) {
      ending = "timed_out";
      break;
    }
    if (!accessUsable(state.serverAccess.get(a.serverCode))) {
      ending = "access_lost";
      break;
    }
    // L'uso si registra alla prima lettura vera, non prima.
    if (ran.size === 0) markUsed(a.serverCode, { kind: "analysis", analysisId: a.id });
    ran.add(commandInput(next.command));
    await runScript(a.conversationId, readSteps([next]), gen);
    if (!alive()) return;
  }
  if (ending === "diagnosed" && ran.size === 0) ending = "recovered_early";
  return finish(a, episode, gen, ending, ran.size);
}

/** I consumi finti dell'analisi: plausibili, sotto il tetto (`ANALYSIS_MAX_COST_USD`). */
function usageOf(reads: number): ModelUsage {
  return {
    model: "claude-sonnet-4-5",
    inputTokens: 6_200 + 4_100 * reads,
    outputTokens: 900 + 260 * reads,
    cacheReadTokens: 3_800 * reads,
    costUsd: Math.min(ANALYSIS_MAX_COST_USD, Math.round((0.05 + 0.04 * reads) * 100) / 100),
  };
}

/**
 * Come finisce un'analisi che apre la task: con la diagnosi, al limite di
 * tempo, col server irraggiungibile, rientrato prima di ogni lettura, o con
 * l'accesso di lettura non più usabile a metà.
 */
type Ending = "diagnosed" | "timed_out" | "unreachable" | "recovered_early" | "access_lost";

const ANALYSIS_OUTCOME: Record<Ending, ServerAnalysis["outcome"]> = {
  diagnosed: "diagnosed",
  timed_out: "timed_out",
  unreachable: "unreachable",
  recovered_early: "stopped",
  access_lost: "stopped",
};

const SESSION_OUTCOME: Record<Ending, Outcome> = {
  diagnosed: "ok",
  timed_out: "timed_out",
  unreachable: "failed",
  recovered_early: "ok",
  access_lost: "failed",
};

/** La diagnosi della cornice: lo sguardo generale, o i motivi dell'episodio. */
const diagnosisFor = (s: MonitoredServer, ep: ServerEpisode) =>
  looks.has(ep) ? lookDiagnosisOf(s) : diagnosisOf(s, ep, reachOf(s));

/** Che cosa si guardava, in frase: i motivi, o lo sguardo a mano. */
const whatPhrase = (ep: ServerEpisode): string =>
  looks.has(ep) ? "a check on request, no alert" : reasonsPhrase(ep.reasons);

/** L'apertura della sessione: a mano dice chi l'ha chiesta. */
function openingOf(s: MonitoredServer, ep: ServerEpisode, a: ServerAnalysis): ScriptStep[] {
  const steps = openingSteps(s, ep);
  const who = askedBy(a);
  if (!who) return steps;
  return steps.map((x) =>
    x.step === "say"
      ? {
          ...x,
          text: `${s.name}: ${who} asked me to look into it (${whatPhrase(ep)}). Looking into it with the read-only access (at most ${ANALYSIS_MAX_MINUTES} minutes).`,
        }
      : x,
  );
}

function taskOf(
  s: MonitoredServer,
  ep: ServerEpisode,
  outcome: Ending,
  reads: number,
  a?: ServerAnalysis,
) {
  const d = diagnosisFor(s, ep);
  const proposal = d.proposal.startsWith("- ")
    ? `**Proposal**\n${d.proposal}`
    : `**Proposal** — ${d.proposal}`;
  const untouched = "Claude looked with the read-only access: nothing was changed on the server.";
  let title = d.title;
  let parts: string[];
  if (outcome === "unreachable") {
    title = `${s.name} not reachable over SSH`;
    parts = [
      `**Not reachable** — Claude couldn't connect to ${s.name} (${s.code}) over SSH: ${ATTEMPTS} attempts, all timed out, so there is no diagnosis. The alert was: ${whatPhrase(ep)}.`,
      "**Proposal** — Check the server from the provider's console. Once SSH answers again, the next alert is looked into as usual.",
    ];
  } else if (outcome === "recovered_early") {
    title = `${s.name}: ${reasonsPhrase(ep.reasons)}, back to normal`;
    parts = [
      `**Back to normal before Claude looked** — the alert on ${s.name} (${s.code}) was: ${reasonsPhrase(ep.reasons)}. It cleared before the first read, so there is no diagnosis.`,
      "**Proposal** — Nothing to do unless it happens again; the server's charts show what happened.",
    ];
  } else if (outcome === "access_lost") {
    parts = [
      `**Stopped** — the read-only SSH access stopped being usable after ${reads} read${reads === 1 ? "" : "s"}, so Claude stopped. ${reads > 0 ? `What it saw so far: ${d.body}` : "There is no diagnosis."}`,
      ...(reads > 0 ? [proposal] : []),
      untouched,
    ];
  } else if (outcome === "timed_out") {
    parts = [
      `**Partial diagnosis** — Claude stopped after ${ANALYSIS_MAX_MINUTES} minutes, the analysis limit, after ${reads} reads. What it saw so far: ${d.body}`,
      proposal,
      untouched,
    ];
  } else {
    parts = [`**Diagnosis** — ${d.body}`, proposal, untouched];
  }
  if (ep.recoveredAt !== null && outcome !== "recovered_early") parts.push(recoveredLine(ep));
  const who = a ? askedBy(a) : null;
  if (who) parts.push(`Analysis asked by ${who} from the server page, not started by an alert.`);
  return { title, description: parts.join("\n\n"), parts };
}

/**
 * La diagnosi che resta sull'analisi quando la causa non è determinata: il
 * testo della task che non nasce, SENZA la proposta (niente piano senza un
 * progetto, F4b-4).
 */
const undeterminedDiagnosisOf = (
  s: MonitoredServer,
  ep: ServerEpisode,
  outcome: Ending,
  reads: number,
  a: ServerAnalysis,
): string =>
  taskOf(s, ep, outcome, reads, a)
    .parts.filter((p) => !p.startsWith("**Proposal**"))
    .join("\n\n");

/**
 * Perché il progetto non si può dire, in inglese come gli altri testi dei
 * dati (avviso e sessione); la UI ha le sue frasi
 * (`servers.attribution.<reason>`).
 */
const UNDETERMINED: Record<Extract<ServerAttribution, { kind: "undetermined" }>["reason"], string> =
  {
    no_project: "the analysis didn't name a project",
    project_not_on_server: "the project it named doesn't use this server",
    no_containers: "it didn't name a container, and more than one project uses this server",
    unknown_container: "it named a container the agent doesn't report on this server",
    no_container_of_project:
      "none of the containers it named belongs to that project's environments",
    containers_of_other_project: "it named a container that belongs to another project",
  };

/** L'inizio del corpo di «Diagnosi pronta», per esito. */
const READY_BODY: Record<Ending, (name: string) => string> = {
  diagnosed: (name) => `Claude looked into ${name} with read-only access`,
  timed_out: (name) => `Claude looked into ${name} with read-only access, until the time limit`,
  unreachable: (name) => `Claude couldn't reach ${name} over SSH`,
  recovered_early: (name) => `${name} was back to normal before Claude looked`,
  access_lost: (name) => `Claude stopped looking into ${name}: the read-only access isn't usable`,
};

/**
 * La task non si è aperta (o il seguito è fallito per altro): l'analisi
 * finisce `failed`, la sessione lo dice, e il server non resta «occupato».
 */
async function failAnalysis(a: ServerAnalysis, gen: number, e: unknown): Promise<void> {
  if (gen !== storeGeneration() || a.outcome !== "running") return;
  const reason = e instanceof Error ? e.message : String(e);
  a.outcome = "failed";
  a.endedAt = now();
  const c = state.conversations.find((x) => x.id === a.conversationId);
  if (c) {
    c.failureSummary = `Couldn't open the task: ${reason}`;
    notifyConversationChange(c.id);
  }
  // Chi ha letto «Claude is looking into it» deve sapere che non è finita:
  // lo stesso tipo dell'avviso dell'episodio, agli stessi progetti (quindi
  // alle stesse persone, con le stesse iscrizioni).
  const s = serverOf(a.serverCode);
  const ep = state.serverEpisodes.find((x) => x.id === a.episodeId);
  if (s && ep) {
    for (const projectId of alertProjectsOf(s.code, liveEnvironments())) {
      publishAlert({
        kind: ep.severity === "down" ? "server.down" : "server.trouble",
        projectId,
        objectCode: s.code,
        title: "Claude couldn't finish the analysis",
        body: `${s.name}: ${reasonsPhrase(ep.reasons)}. Claude looked into it but couldn't open the task (${reason}), so there is no diagnosis.`,
        link: serverHref(projectCode(projectId), s.code),
      });
    }
  }
  await runScript(
    a.conversationId,
    [
      { step: "finish_action", outcome: "failed" },
      { step: "say", text: `I couldn't open the task for this analysis (${reason}).` },
      { step: "event", event: { type: "phase", phase: "analysis", outcome: "failed" } },
      { step: "state", state: "finished", outcome: "failed" },
    ],
    gen,
  );
}

/**
 * L'attribuzione (F4b-4): la causa che l'analisi dichiara, validata dalla
 * regola pura di `@stubwise/shared` contro i progetti che usano il server
 * ADESSO (non archiviati) e i container che l'agente riporta. Senza letture
 * l'analisi non dichiara niente: vale solo «un solo progetto, quello».
 */
function attributionOf(s: MonitoredServer, ep: ServerEpisode, reads: number): ServerAttribution {
  const serverProjects = serverProjectsOf(s.code, liveEnvironments(), projectCode);
  return attributeServerCause({
    serverProjects,
    seenContainers: docker(s).map((x) => x.name),
    cause:
      reads > 0 ? declaredCauseOf(s, ep, serverProjects) : { projectCode: null, containers: [] },
  });
}

async function finish(
  a: ServerAnalysis,
  ep: ServerEpisode,
  gen: number,
  outcome: Ending,
  reads: number,
): Promise<void> {
  if (gen !== storeGeneration()) return;
  const s = serverOf(a.serverCode);
  if (!s) return;
  const attribution = attributionOf(s, ep, reads);
  a.attribution = attribution;
  const c = state.conversations.find((x) => x.id === a.conversationId);
  if (c) {
    // Col modello con cui è partita (area 9b, `fix_plan`).
    c.usage = [{ ...usageOf(reads), ...(c.model ? { model: c.model } : {}) }];
    notifyConversationChange(c.id);
  }
  if (attribution.kind === "undetermined") return finishUndetermined(a, ep, gen, outcome, reads);
  const projectId = attribution.projectId;
  // La sessione entra nel progetto attribuito: lì la legge chi legge il progetto.
  // Prima della task: se la task non si apre, la sessione dice perché lì.
  if (c) {
    c.projectId = projectId;
    c.touchedProjectIds = [projectId];
    notifyConversationChange(c.id);
  }
  const { title, description } = taskOf(s, ep, outcome, reads, a);
  const task: Task = createTaskAs(
    CLAUDE_ID,
    {
      projectId,
      title,
      description,
      type: "bug",
      assigneeId: null,
      priority: ep.severity === "down" ? "urgent" : "high",
    },
    { source: "server", serverRef: { serverCode: s.code, episodeId: a.episodeId } },
  );
  // Claude non segue la task: non è una persona da avvisare (R-K5).
  task.followerIds = [];
  a.outcome = ANALYSIS_OUTCOME[outcome];
  a.taskId = task.id;
  // La proposta (la stessa della task) per «Suggested fix» della sezione
  // Server: solo se Claude ha letto qualcosa da cui proporre.
  const proposes =
    outcome === "diagnosed" || outcome === "timed_out" || (outcome === "access_lost" && reads > 0);
  a.proposal = proposes ? diagnosisFor(s, ep).proposal : null;
  a.endedAt = now();
  if (c) {
    c.taskId = task.id;
    notifyConversationChange(c.id);
  }
  const code = projectCode(projectId);
  const link = `#/p/${code}/tasks?task=${task.code}`;
  publishAlert({
    kind: "server.diagnosis_ready",
    projectId,
    objectCode: s.code,
    title: "Diagnosis ready",
    body: `${READY_BODY[outcome](s.name)}: ${task.code} ${task.title}.`,
    link,
  });
  const said: Record<Ending, string> = {
    unreachable: `I couldn't reach ${s.name} over SSH after ${ATTEMPTS} attempts. I opened ${task.code} anyway, with what we know.`,
    timed_out: `I stopped after ${ANALYSIS_MAX_MINUTES} minutes, the analysis limit. I wrote what I saw so far in ${task.code}.`,
    recovered_early: `The server was back to normal before I read anything. I noted it in ${task.code}.`,
    access_lost: `The read-only access stopped being usable, so I stopped. I wrote what I saw in ${task.code}.`,
    diagnosed: `${ep.recoveredAt !== null ? "The server is back to normal, so I stopped there. " : ""}I wrote the diagnosis and a proposal in ${task.code}.`,
  };
  const phaseOutcome = SESSION_OUTCOME[outcome];
  await runScript(
    a.conversationId,
    [
      // Un rientro può aver interrotto una lettura a metà: si chiude.
      { step: "finish_action" },
      { step: "say", text: said[outcome] },
      {
        step: "event",
        event: {
          type: "work_result",
          kind: "server_diagnosis",
          text: `Diagnosis written in ${task.code}`,
          link,
        },
      },
      { step: "event", event: { type: "phase", phase: "analysis", outcome: phaseOutcome } },
      { step: "state", state: "finished", outcome: phaseOutcome },
    ],
    gen,
  );
}

/**
 * La causa non determinata (F4b-4): nessuna task, nessuna proposta. La
 * diagnosi resta sull'analisi; le produzioni che usano il server lo sanno
 * («Cause not determined», al server, non a una task). La sessione resta
 * senza progetto: la legge chi gestisce il monitor.
 */
async function finishUndetermined(
  a: ServerAnalysis,
  ep: ServerEpisode,
  gen: number,
  outcome: Ending,
  reads: number,
): Promise<void> {
  const s = serverOf(a.serverCode)!;
  const why = a.attribution?.kind === "undetermined" ? UNDETERMINED[a.attribution.reason] : "";
  a.outcome = ANALYSIS_OUTCOME[outcome];
  a.taskId = null;
  a.proposal = null;
  a.diagnosis = undeterminedDiagnosisOf(s, ep, outcome, reads, a);
  a.endedAt = now();
  for (const to of alertProjectsOf(s.code, liveEnvironments())) {
    publishAlert({
      kind: "server.diagnosis_ready",
      projectId: to,
      objectCode: s.code,
      title: "Cause not determined",
      body: `${READY_BODY[outcome](s.name)}, but couldn't tell which project is causing it: ${why}. No task was opened.`,
      link: serverHref(projectCode(to), s.code),
    });
  }
  const phaseOutcome = SESSION_OUTCOME[outcome];
  await runScript(
    a.conversationId,
    [
      { step: "finish_action" },
      {
        step: "say",
        text: `I couldn't tell which project is causing it (${why}), so I didn't open a task or propose a fix. The diagnosis stays with the alert on ${s.code}.`,
      },
      { step: "event", event: { type: "phase", phase: "analysis", outcome: phaseOutcome } },
      { step: "state", state: "finished", outcome: phaseOutcome },
    ],
    gen,
  );
}
