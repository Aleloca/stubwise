import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentSessionEvents,
  agentSessionInputs,
  backlogItems,
  backlogRefineSessions,
  gitAccounts,
  monthlyCostUsd,
  projectDecisions,
  repositories,
  users,
  type Db,
} from "@stubwise/db";
import { decryptGitCredentials } from "@stubwise/notifications";
import { AGENT_SESSION_EVENTS_CHANNEL, type AgentInputReason, type AgentInputStatus } from "@stubwise/shared";
import { mergeDisallowedTools, scopedReadTools, sensitiveReadDenyRules } from "../../agent/read-scope.js";
import { AgentRunCancelledError, type AgentRunOptions, type AgentRunResult, type AgentRunner } from "../../agent/runner.js";
import type { MirrorManager, ProjectWorktreeRepo } from "../../git/mirrors.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, renderGraphHint, resolveRepoGraphJson } from "../../graph/agent-hint.js";
import type { ProjectSerializer } from "../../handler.js";
import { loadMonthlyBudgetUsd } from "../../pipeline/job-outcomes.js";
import { openRunPlugins } from "../../plugins/materialize-run.js";
import type { ResolvedProvider } from "../../providers/chain.js";
import { isLimitError } from "../../providers/limit.js";
import { limitTextOfRun, type SelectDeps } from "../../providers/select.js";
import { backlogRefineSession } from "../../sessions/owners.js";
import { getContentLanguage } from "../../settings.js";
import { t } from "@stubwise/i18n";
import { NoAccountAvailableError, runBacklogWithProviders } from "../provider.js";
import { buildRefineMcpConfig, refineServerPath, type RefineBridge, type RefineTurnGrant } from "./bridge.js";
import { buildRefinePrimingPrompt, buildRefineResumePrompt } from "./prompts.js";
import { refineParentDir, type RefineWorktreeEntry, type RefineWorktreeRegistry } from "./worktrees.js";

/**
 * UN turno di una sessione di refinement (design 2026-10-14 §3.2, §3.4, §4,
 * §5.5): nasce da un messaggio (l'input d'apertura, scelto dallo scheduler),
 * gira FUORI dal serializer del progetto (che si usa solo per aprire i
 * worktree) e riprende la conversazione CLI con `--resume`. Mai due turni
 * sulla stessa sessione: lo garantisce lo scheduler (Task 10).
 *
 * L'ordine conta:
 * 1. sessione `active` e voce aperta, poi budget mensile (un member si ferma,
 *    un admin passa): PRIMA del serializer, con UPDATE guardati su
 *    `status = 'pending'` — l'input non è ancora reclamato;
 * 2. provider, worktree (dal registro, o aperti nel serializer), plugin,
 *    grafo, ponte;
 * 3. CLAIM dell'input (`pending → delivered`) SOLO ORA, subito prima del run:
 *    finché il turno aspetta il serializer l'input resta `pending` e la
 *    sessione si mostra `queued`, non `working`;
 * 4. run; `--resume` rifiutato → UN nuovo tentativo col prompt d'avvio.
 *    «Rifiutato» = exit ≠ 0 SENZA eco con un `cli_session_id` salvato: non
 *    si distingue da un'uscita transitoria (crash, rete) prima che il CLI
 *    prendesse il messaggio, e la si conta allo stesso modo — costa al più
 *    UN tentativo di priming in più, e se fallisce anche quello l'id salvato
 *    si scarta (il turno dopo riparte col prompt d'avvio e i messaggi recenti);
 * 5. esito. Un turno il cui messaggio il CLI non ha MAI preso marca l'input
 *    `undelivered`/`turn_failed` QUI, prima di restituire — fallito, ma anche
 *    RIUSCITO (exit 0 senza eco): il relay (`inputsNotEchoed`) l'ha già
 *    riportato a `pending` e, senza questo, lo scheduler ne farebbe il turno
 *    dopo all'infinito, un run pagato a giro.
 * Il segreto del ponte vale un turno: si revoca nel `finally`. I worktree
 * restano nel registro (li smonta lo scheduler alla chiusura).
 *
 * ANNULLAMENTO (`signal`, «Chiudi» o voce chiusa): si controlla a ogni passo
 * prima del run e l'attesa del serializer si interrompe subito (un fix lungo
 * sullo stesso progetto non tiene ferma la chiusura). Un turno annullato il
 * cui messaggio il CLI non ha preso lo lascia `pending`: lo chiude lo
 * scheduler (`session_not_live`). Uno «Ferma» (run annullato col `signal`
 * NON scattato) prima dell'eco lo marca invece `undelivered`/`stdin_closed`:
 * mai di nuovo in coda, o ripartirebbe da solo.
 *
 * ERRORI DEL DB nei passi prima del `try` (lettura dell'input, sessione,
 * budget) RIGETTANO la promise: li gestisce il chiamante (lo scheduler).
 */

/**
 * `Skill`: le skill dei plugin (brainstorming, writing-plans di `superpowers`)
 * servono qui (§4.2), e con l'allowlist chiusa un tool fuori elenco è negato.
 */
const SKILL_TOOL = "Skill";

/**
 * L'allowlist CHIUSA di un turno (§4.2): letture SOLO sotto la parent dir dei
 * worktree della sessione (`Read(//<parentDir>/**)`, mai `Read` nudo: con
 * quello il CLI concede anche le letture fuori dalla cwd, scenario golden
 * `refine-read`) e sotto le copie dei plugin del run, `Skill`, i tool del
 * grafo solo con almeno un grafo, i tool di scrittura del ponte solo con
 * l'entry MCP. Esportata perché gli scenari
 * golden `refine` e `refine-read` usino la STESSA, non una copia.
 */
export function refineAllowedTools(
  parentDir: string,
  graphs: readonly unknown[],
  mcp: { tools: readonly string[] } | null,
  pluginDirs: readonly string[] = [],
): string[] {
  return [
    ...scopedReadTools(parentDir),
    // Le skill rimandano a file accanto al loro SKILL.md: si leggono dalle
    // copie di QUESTO run (`plugins.options.pluginDirs`, la tmp di
    // `openRunPlugins` e il plugin base), mai con un glob su ogni
    // `stubwise-plugins-*` né dal volume `PLUGINS_DIR`, che resta negato.
    ...pluginDirs.flatMap((dir) => scopedReadTools(dir)),
    SKILL_TOOL,
    ...(graphs.length > 0 ? GRAPHIFY_AGENT_ALLOWED_TOOLS : []),
    ...(mcp?.tools ?? []),
  ];
}

/**
 * Le deny rule di un turno: i percorsi sensibili (`sensitiveReadDenyRules`,
 * difesa in profondità sopra l'allowlist ristretta) UNITE a quelle dei
 * plugin (`Skill(<plugin>:<skill>)`), che restano tutte. Esportata per gli
 * scenari golden, come {@link refineAllowedTools}.
 */
export function refineDisallowedTools(opts: { pluginsDir?: string; pluginDeny?: readonly string[] }): string[] {
  return mergeDisallowedTools(
    opts.pluginDeny,
    sensitiveReadDenyRules(opts.pluginsDir !== undefined ? { pluginsDir: opts.pluginsDir } : {}),
  );
}
const DECISIONS_IN_PROMPT = 10;
const TRANSCRIPT_IN_PROMPT = 20;

export interface RefineTurnDeps {
  db: Db;
  runner: AgentRunner;
  mirrors: Pick<MirrorManager, "openProjectWorktrees">;
  serializer: ProjectSerializer;
  worktrees: RefineWorktreeRegistry;
  bridge: RefineBridge;
  encryptionKey: Buffer;
  graphsDir?: string;
  pluginsDir?: string;
  model?: string;
  maxTurns: number;
  turnTimeoutMs: number;
  refineServerPath?: string;
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  /** Scelta dell'account (providers/select.ts), la stessa di tutto il worker. */
  select: SelectDeps;
  /** Iniettabile nei test: i repository del progetto con le credenziali decifrate. */
  loadMirrorProjectsFn?: (db: Db, projectId: string) => Promise<ProjectWorktreeRepo[]>;
  log: (m: string) => void;
}

export type RefineTurnOutcome = "completed" | "cancelled" | "failed" | "skipped";

/** Tutti i repository del progetto, in ordine di slug (come il fix). */
async function loadMirrorProjects(
  deps: Pick<RefineTurnDeps, "db" | "encryptionKey">,
  projectId: string,
): Promise<ProjectWorktreeRepo[]> {
  const rows = await deps.db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.projectId, projectId))
    .orderBy(repositories.slug);
  return rows.map(({ repository, account }) => {
    const credentials = decryptGitCredentials(account.encryptedCredentials, deps.encryptionKey);
    // Errore di configurazione: nomina il repository, MAI il payload.
    if (credentials === null) {
      throw new Error(`credenziali git del repository '${repository.name}' non decifrabili`);
    }
    return {
      repositoryId: repository.id,
      name: repository.name,
      project: {
        provider: repository.provider,
        repoUrl: repository.repoUrl,
        defaultBranch: repository.defaultBranch,
        credentials,
      },
    };
  });
}

/** `from → delivered`, lo stesso UPDATE guardato del relay: chi perde non consegna. */
async function claimOpening(db: Db, inputId: string, from: AgentInputStatus[]): Promise<boolean> {
  const claimed = await db
    .update(agentSessionInputs)
    .set({ status: "delivered", deliveredAt: sql`now()` })
    .where(and(eq(agentSessionInputs.id, inputId), inArray(agentSessionInputs.status, from)))
    .returning({ id: agentSessionInputs.id });
  return claimed.length > 0;
}

/** `from → undelivered` con il motivo, guardato; NOTIFY degli eventi se la riga è cambiata. */
async function markUndelivered(
  db: Db,
  sessionId: string,
  inputId: string,
  reason: AgentInputReason,
  from: AgentInputStatus[],
): Promise<boolean> {
  const updated = await db
    .update(agentSessionInputs)
    .set({ status: "undelivered", reason, deliveredAt: null })
    .where(and(eq(agentSessionInputs.id, inputId), inArray(agentSessionInputs.status, from)))
    .returning({ id: agentSessionInputs.id });
  if (updated.length === 0) return false;
  // Best-effort: lo stato è già in tabella, lo stream lo rilegge al prossimo evento.
  await db
    .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
    .catch(() => undefined);
  return true;
}

/** Un avviso da template nella trascrizione (fuori da ogni segmento del CLI), con NOTIFY. */
async function noticeInTranscript(db: Db, sessionId: string, text: string): Promise<void> {
  await db.insert(agentSessionEvents).values({
    sessionId,
    segmentId: `stubwise-notice-${randomUUID()}`,
    type: "assistant_text",
    data: { text },
  });
  await db
    .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
    .catch(() => undefined);
}

/** Il CLI ha PRESO il messaggio: il runner scrive l'evento `input` col suo id all'eco. */
async function echoed(db: Db, sessionId: string, inputId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessionEvents.id })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, sessionId),
        eq(agentSessionEvents.type, "input"),
        sql`${agentSessionEvents.data}->>'inputId' = ${inputId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Budget mensile sforato (stessa lettura di `checkBudgetsBeforeRun`). */
async function overBudget(deps: RefineTurnDeps): Promise<boolean> {
  const limit = await loadMonthlyBudgetUsd(deps.db);
  if (limit === null) return false;
  return (await (deps.monthlyCostUsdFn ?? monthlyCostUsd)(deps.db)) >= limit;
}

async function isAdmin(db: Db, userId: string | null): Promise<boolean> {
  if (userId === null) return false; // autore eliminato: nessuno scavalca il budget
  const [author] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return author?.role === "admin";
}

/** Ultimi messaggi della trascrizione (persona e agente), per ripartire senza --resume. */
async function recentTranscript(db: Db, sessionId: string, excludeInputId: string) {
  const rows = await db
    .select({ type: agentSessionEvents.type, data: agentSessionEvents.data })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, sessionId),
        inArray(agentSessionEvents.type, ["input", "assistant_text"]),
      ),
    )
    .orderBy(desc(agentSessionEvents.id))
    .limit(TRANSCRIPT_IN_PROMPT + 1);
  return rows
    .filter((r) => !(r.type === "input" && r.data["inputId"] === excludeInputId))
    .slice(0, TRANSCRIPT_IN_PROMPT)
    .reverse()
    .flatMap((r) => {
      const text = r.data["text"];
      return typeof text === "string" && text !== ""
        ? [{ role: r.type === "input" ? ("user" as const) : ("agent" as const), text }]
        : [];
    });
}

/** `delivered → pending` (guardato): un messaggio reclamato e mai preso dal CLI torna in coda. */
async function backToPending(db: Db, sessionId: string, inputId: string): Promise<void> {
  const updated = await db
    .update(agentSessionInputs)
    .set({ status: "pending", deliveredAt: null })
    .where(and(eq(agentSessionInputs.id, inputId), eq(agentSessionInputs.status, "delivered")))
    .returning({ id: agentSessionInputs.id });
  if (updated.length === 0) return;
  await db
    .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
    .catch(() => undefined);
}

/** `task`, o `null` appena il segnale scatta (il task continua per conto suo). */
async function untilAborted<T>(task: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return null;
  let onAbort = (): void => undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runRefineTurn(
  deps: RefineTurnDeps,
  input: { agentSessionId: string; inputId: string; signal: AbortSignal },
): Promise<RefineTurnOutcome> {
  const { db, log } = deps;
  const sid = input.agentSessionId;

  // 0. Il messaggio d'apertura, ancora `pending`: reclamato solo al passo 6.
  const [opening] = await db
    .select()
    .from(agentSessionInputs)
    .where(and(eq(agentSessionInputs.id, input.inputId), eq(agentSessionInputs.sessionId, sid)));
  if (!opening || opening.status !== "pending") return "skipped";

  // 1. Sessione attiva e voce aperta.
  const [ctx] = await db
    .select({ refine: backlogRefineSessions, item: backlogItems })
    .from(backlogRefineSessions)
    .innerJoin(backlogItems, eq(backlogItems.id, backlogRefineSessions.itemId))
    .where(eq(backlogRefineSessions.agentSessionId, sid));
  if (!ctx || ctx.refine.status !== "active" || ctx.item.status === "converted" || ctx.item.status === "archived") {
    await markUndelivered(db, sid, opening.id, "session_not_live", ["pending"]);
    return "skipped";
  }
  const { item } = ctx;

  // 2. Budget mensile: il messaggio di un maintainer passa, quello di un member
  //    no (stessa regola delle correzioni, `correctionManualTrigger`).
  if ((await overBudget(deps)) && !(await isAdmin(db, opening.authorUserId))) {
    await markUndelivered(db, sid, opening.id, "budget_exceeded", ["pending"]);
    return "skipped";
  }

  let grant: RefineTurnGrant | undefined;
  let cleanupPlugins: () => Promise<void> = async () => undefined;
  /** `--resume` rifiutato: se il turno non riesce, l'id salvato non vale più. */
  let resumeRejected = false;
  const saveCliSessionId = (cliSessionId: string | null) =>
    db.update(backlogRefineSessions).set({ cliSessionId }).where(eq(backlogRefineSessions.agentSessionId, sid));
  try {
    // 3. L'account lo sceglie runBacklogWithProviders al momento del run (passo
    //    7–8), come la chat CODE: classe `interactive`.

    // 4. Worktree: dal registro (mai sovrascritto: set() su un'entry viva ne
    //    perderebbe i worktree), o aperti nel serializer (solo l'apertura).
    let entry: RefineWorktreeEntry | undefined = deps.worktrees.get(sid);
    if (!entry) {
      const repos = await (deps.loadMirrorProjectsFn ?? ((_db, projectId) => loadMirrorProjects(deps, projectId)))(
        db,
        item.projectId,
      );
      if (repos.length === 0) throw new Error(`il progetto ${item.projectId} non ha repository`);
      const parentDir = refineParentDir(sid);
      const { signal } = input;
      // Il serializer non è annullabile: il task controlla il segnale prima di
      // aprire e dopo (annullato a metà apertura → smonta da sé), e il turno
      // smette di aspettarlo appena il segnale scatta.
      const task = deps.serializer.run(item.projectId, async () => {
        if (signal.aborted) return null;
        const opened = await deps.mirrors.openProjectWorktrees(repos, `stubwise/backlog-refine-${sid}`, parentDir);
        if (signal.aborted) {
          await opened.remove().catch(() => undefined);
          return null;
        }
        return opened;
      });
      const opened = await untilAborted(task, signal);
      if (opened === null) {
        // Il task, se apre comunque (segnale scattato fra la sua fine e la
        // nostra ripresa), non entra mai nel registro: si smonta qui.
        void task.then((late) => late?.remove()).catch(() => undefined);
        return "cancelled";
      }
      entry = { agentSessionId: sid, parentDir, repos: opened.dirs, remove: opened.remove };
      deps.worktrees.set(entry);
    }
    const worktree = entry;
    // «Chiudi» arrivato mentre il turno aspettava: l'input resta `pending`, lo
    // chiude lo scheduler (`session_not_live`) insieme ai worktree.
    if (input.signal.aborted) return "cancelled";

    // 5. Plugin (a OGNI turno: il flag non persiste nella sessione CLI), grafo, ponte.
    const plugins = await openRunPlugins(db, {
      projectId: item.projectId,
      ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
      log,
    });
    cleanupPlugins = plugins.cleanup;
    const graphsDir = deps.graphsDir;
    const graphs =
      graphsDir === undefined
        ? []
        : worktree.repos.flatMap((r) => {
            const path = resolveRepoGraphJson(graphsDir, r.repositoryId);
            return path === null ? [] : [{ label: r.name, graphJsonPath: path }];
          });
    if (input.signal.aborted) return "cancelled";
    grant = deps.bridge.grant({ agentSessionId: sid, itemId: item.id });
    const mcp = buildRefineMcpConfig(deps.bridge, grant, deps.refineServerPath ?? refineServerPath());
    if (mcp === null) {
      log(`[refine] tool di scrittura non disponibili (entry MCP assente): la sessione ${sid} non potrà salvare design e piano`);
    }
    const allowedTools = refineAllowedTools(worktree.parentDir, graphs, mcp, plugins.options.pluginDirs ?? []);
    const disallowedTools = refineDisallowedTools({
      ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
      ...(plugins.options.disallowedTools !== undefined ? { pluginDeny: plugins.options.disallowedTools } : {}),
    });

    // Sempre con gli ultimi messaggi (l'apertura esclusa): vuoti al vero primo
    // turno, e il contesto di un turno precedente fallito dopo l'eco non si perde.
    const priming = async () =>
      buildRefinePrimingPrompt(
        {
          language: await getContentLanguage(db),
          item: {
            title: item.title,
            document: item.document,
            implementationPlan: item.implementationPlan,
            originContent: item.originContent,
            effort: item.effort,
            risk: item.risk,
            riskNote: item.riskNote,
            urgency: item.urgency,
          },
          repos: worktree.repos.map((r) => ({ name: r.name, dir: r.dir })),
          graphHint: renderGraphHint(graphs, "it"),
          decisions: await db
            .select({
              title: projectDecisions.title,
              decision: projectDecisions.decision,
              decidedAt: projectDecisions.decidedAt,
            })
            .from(projectDecisions)
            .where(and(eq(projectDecisions.projectId, item.projectId), isNull(projectDecisions.supersededById)))
            .orderBy(desc(projectDecisions.decidedAt))
            .limit(DECISIONS_IN_PROMPT),
          recentTranscript: await recentTranscript(db, sid, opening.id),
        },
        opening.text,
      );
    // Il tetto della pausa è del TURNO: i due tentativi lo condividono.
    const session = backlogRefineSession(sid, randomUUID());
    const attempt = (
      resumeSessionId: string | null,
      prompt: string,
      provider: ResolvedProvider | undefined,
    ): Promise<AgentRunResult> =>
      deps.runner.run({
        cwd: worktree.parentDir,
        prompt,
        permissionMode: "default",
        allowedTools,
        maxTurns: deps.maxTurns,
        timeoutMs: deps.turnTimeoutMs,
        ...(deps.model !== undefined ? { model: deps.model } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(resumeSessionId !== null ? { resumeSessionId } : {}),
        ...(mcp !== null ? { mcpConfig: mcp.mcpConfig } : {}),
        ...plugins.options,
        // DOPO lo spread dei plugin: le loro deny rule sono già dentro.
        disallowedTools,
        session,
        openingInput: { inputId: opening.id, text: opening.text, authorUserId: opening.authorUserId },
        signal: input.signal,
      } satisfies AgentRunOptions);

    const stored = ctx.refine.cliSessionId;
    const firstPrompt = stored !== null ? buildRefineResumePrompt(opening.text) : await priming();

    // 6. CLAIM, subito prima del run (e mai a turno già annullato: il runner
    //    lancerebbe prima di avviare il processo, e l'input resterebbe
    //    `delivered` senza eco). Perso (input chiuso o preso nel frattempo) →
    //    skipped; i worktree restano nel registro.
    if (input.signal.aborted) return "cancelled";
    if (!(await claimOpening(db, opening.id, ["pending"]))) return "skipped";

    // 7–8. Run, con UN nuovo tentativo se il --resume è rifiutato (riavvio del
    //    worker, file di sessione del CLI spariti): exit ≠ 0 e il messaggio mai
    //    preso, qualunque session id il CLI abbia riportato. Il tutto per
    //    account (runBacklogWithProviders, providers/select.ts): un run finito
    //    al LIMITE non è un --resume rifiutato — passa all'account successivo,
    //    che riprende la stessa conversazione (la credenziale arriva via env,
    //    la sessione CLI è su disco). Prima di ogni account dopo il primo il
    //    messaggio si reclama di nuovo: senza eco il relay l'ha riportato a
    //    `pending`.
    type ProviderAttempt = { kind: "run"; result: AgentRunResult } | { kind: "skipped" };
    let firstAccount = true;
    const outcome = await runBacklogWithProviders<ProviderAttempt>(
      deps,
      item.projectId,
      "refine",
      async (provider) => {
        if (!firstAccount && !(await claimOpening(db, opening.id, ["pending", "delivered"]))) {
          return { kind: "skipped" };
        }
        firstAccount = false;
        const resumeId = resumeRejected ? null : stored;
        let res = await attempt(resumeId, resumeId !== null || stored === null ? firstPrompt : await priming(), provider);
        if (isLimitError(res)) return { kind: "run", result: res };
        if (resumeId !== null && res.exitCode !== 0 && !(await echoed(db, sid, opening.id))) {
          log(`[refine] --resume ${resumeId} rifiutato per la sessione ${sid}: riparto col prompt d'avvio`);
          resumeRejected = true;
          // Il relay l'ha riportato a `pending` (nessuna eco): si reclama di nuovo.
          if (!(await claimOpening(db, opening.id, ["pending", "delivered"]))) return { kind: "skipped" };
          res = await attempt(null, await priming(), provider);
        }
        return { kind: "run", result: res };
      },
      (v) => (v.kind === "run" ? limitTextOfRun(v.result) : null),
    );
    if (outcome.kind === "skipped") return "skipped";
    const result = outcome.result;
    if (result.exitCode !== 0) {
      // Il CLI ha riportato una sessione: si salva sempre (il turno dopo la
      // riprende). Senza, dopo un --resume rifiutato l'id vecchio si scarta.
      const keep = result.sessionId ?? (resumeRejected ? null : stored);
      if (keep !== stored) await saveCliSessionId(keep);
      resumeRejected = false;
      throw new Error(`agente uscito con exit ${result.exitCode}`);
    }

    // 9. Riuscito. Dopo un --resume rifiutato l'id vecchio non vale più,
    //    anche se il CLI non ne riporta uno nuovo.
    const fallbackId = resumeRejected ? null : stored;
    resumeRejected = false;
    await db
      .update(backlogRefineSessions)
      .set({ cliSessionId: result.sessionId ?? fallbackId, lastActivityAt: sql`now()` })
      .where(eq(backlogRefineSessions.agentSessionId, sid));
    // Exit 0 ma il messaggio d'apertura mai preso dal CLI: il relay l'ha già
    // riportato a `pending`, e la sveglia di fine turno ne farebbe un turno
    // nuovo, poi un altro, per sempre. Si chiude qui, come un turno fallito.
    if (!(await echoed(db, sid, opening.id))) {
      log(`[refine] turno della sessione ${sid} riuscito senza eco dell'input ${opening.id}: marcato turn_failed`);
      await markUndelivered(db, sid, opening.id, "turn_failed", ["pending", "delivered"]).catch((e: unknown) => {
        log(`[refine] input ${opening.id} non marcato turn_failed: ${describeError(e)}`);
      });
    }
    return "completed";
  } catch (error) {
    if (error instanceof AgentRunCancelledError) {
      if (!(await echoed(db, sid, opening.id).catch(() => true))) {
        if (input.signal.aborted) {
          // «Chiudi» o voce chiusa prima che il CLI prendesse il messaggio
          // (es. abort prima dello spawn, senza `inputsNotEchoed`): torna
          // `pending`, e la chiusura lo marca `session_not_live` invece di
          // lasciarlo `delivered` per sempre.
          await backToPending(db, sid, opening.id).catch((e: unknown) => {
            log(`[refine] input ${opening.id} non riportato in coda: ${describeError(e)}`);
          });
        } else {
          // «Ferma» della persona (o pausa scaduta) prima dell'eco: il
          // messaggio NON torna in coda — il turno dopo ripartirebbe da solo
          // con lo stesso testo, l'opposto di ciò che è stato chiesto. Resta
          // `undelivered`/`stdin_closed`: il client mostra «Rimanda» col testo.
          await markUndelivered(db, sid, opening.id, "stdin_closed", ["pending", "delivered"]).catch((e: unknown) => {
            log(`[refine] input ${opening.id} non marcato stdin_closed: ${describeError(e)}`);
          });
        }
      }
      return "cancelled";
    }
    log(`[refine] turno della sessione ${sid} fallito: ${describeError(error)}`);
    if (error instanceof NoAccountAvailableError) {
      // Nessun account disponibile: la risposta del turno è un template (mai
      // l'AI), scritta come testo dell'agente perché chi ha scritto la veda
      // nella conversazione. L'input diventa `turn_failed` qui sotto.
      await noticeInTranscript(db, sid, t(await getContentLanguage(db), "backlog.noAccountAvailable")).catch(
        (e: unknown) => {
          log(`[refine] avviso «nessun account» non scritto nella sessione ${sid}: ${describeError(e)}`);
        },
      );
    }
    // Messaggio mai preso dal CLI → `turn_failed`, PRIMA che lo scheduler
    // svegli il relay: altrimenti tornerebbe il turno dopo, per sempre. Preso
    // → resta `delivered` (è nella trascrizione). Nel dubbio (DB giù) si marca.
    const taken = await echoed(db, sid, opening.id).catch(() => false);
    if (!taken) {
      await markUndelivered(db, sid, opening.id, "turn_failed", ["pending", "delivered"]).catch((e: unknown) => {
        log(`[refine] input ${opening.id} non marcato turn_failed: ${describeError(e)}`);
      });
    }
    return "failed";
  } finally {
    grant?.revoke();
    // --resume rifiutato e turno non riuscito (errore, annullamento, claim
    // perso): i turni dopo non ripagano un --resume che il CLI rifiuta.
    if (resumeRejected) {
      await saveCliSessionId(null).catch((e: unknown) => {
        log(`[refine] cli_session_id della sessione ${sid} non azzerato: ${describeError(e)}`);
      });
    }
    await cleanupPlugins().catch(() => undefined);
  }
}
