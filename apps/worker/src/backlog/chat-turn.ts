import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  backlogQuestions,
  decrypt,
  gitAccounts,
  repositories,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { AgentQuestionAnswer, BacklogChatTurnPayload, Language } from "@stubwise/shared";
import { and, asc, count, eq } from "drizzle-orm";
import { mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { openRunPlugins } from "../plugins/materialize-run.js";
import {
  askUserServerPath,
  buildAskUserRunConfig,
  DEFAULT_AGENT_QUESTION_MAX_ROUNDS,
  readAskUserQuestion,
  type AskUserPayload,
} from "../pipeline/ask-user.js";
import { loadProviderById, loadProviderChain } from "../providers/chain.js";
import { getContentLanguage } from "../settings.js";
import { GRAPHIFY_AGENT_ALLOWED_TOOLS, resolveRepoGraphJson } from "../graph/agent-hint.js";
import type { CodeSessionEntry, CodeSessionRegistry } from "./code-session.js";
import type { BacklogJob, BacklogLogger } from "./poller.js";
import {
  buildCodeChatAnswerPrompt,
  buildCodeChatFollowupPrompt,
  buildCodeChatPrimingPrompt,
  renderAnsweredBacklogQuestion,
  type CodeChatMessage,
} from "./prompts.js";
import { loadProjectAiProviderId, resolveBacklogProvider } from "./provider.js";

/**
 * TURNO della sessione di analisi sul codice del backlog (`kind: chat_turn`).
 *
 * Quando una voce ha una sessione `active`, ogni messaggio della chat diventa un
 * turno dell'agente claude CLI che investiga IN DIRETTA il repository scelto
 * (worktree read-only, `permissionMode: "plan"`, pattern deep dive/PR review). A
 * differenza del deep dive — one-shot, JSON — il turno mantiene una SESSIONE CLI
 * persistente: il primo turno la innesca con un prompt di priming (documento +
 * metadati + storia + domanda) e ne salva il `cli_session_id`; i turni
 * successivi la RIPRENDONO (`--resume`) con la sola nuova domanda, così il
 * modello ricorda cosa ha già esplorato. L'output è la risposta in prosa →
 * messaggio `assistant` in chat.
 *
 * BINDING ALLA SESSIONE DEL PAYLOAD: il turno risponde NELLA sessione in cui è
 * stato posto (`payload.sessionId`). Se quella sessione non è più `active`
 * (DELETE/convert/scadenza nel frattempo, o riapertura su un altro repo) → NO-OP
 * morbido (job done, nessuna risposta): la race col DELETE è ammessa dal server.
 *
 * WORKTREE: aperto pigramente al PRIMO turno (a HEAD del default branch, via
 * MirrorManager.openWorktree DENTRO il serializer per-progetto per non correre
 * col `fetch --prune`); i turni successivi lo riusano dal registro senza passare
 * dal serializer. Al riavvio del worker il registro è vuoto → RI-BOOTSTRAP:
 * riapre il worktree e ri-innesca una NUOVA sessione CLI con la storia dal DB.
 *
 * ERRORI: un turno NON si retry-a. La serializzazione per-item (nel poller) e il
 * fallimento morbido garantiscono che una sessione CLI non abbia mai due
 * `--resume` concorrenti. Su errore/timeout dell'agente → messaggio `assistant`
 * di errore i18n + throw (il poller marca il job `failed` senza riaccodarlo: la
 * domanda resta in chat, l'utente può rimandarla).
 */

/** Ultimi N messaggi della chat inclusi nel priming (oltre alla domanda). */
const MAX_HISTORY_MESSAGES = 20;
/** Cap caratteri complessivo della storia nel priming (difesa dimensione prompt). */
const MAX_HISTORY_CHARS = 20_000;

export interface ChatTurnDeps {
  db: Db;
  runner: AgentRunner;
  /** Mirror manager CONDIVISO: apre il worktree read-only persistente della sessione. */
  mirrors: Pick<MirrorManager, "openWorktree">;
  /** Catena per-progetto CONDIVISA (serializza l'APERTURA del worktree col fetch --prune). */
  serializer: ProjectSerializer;
  /** Registro in-memoria dei worktree delle sessioni (itemId → handle). */
  registry: CodeSessionRegistry;
  logger: BacklogLogger;
  /** Chiave AES-256 per decifrare le credenziali git del repo. */
  encryptionKey: Buffer;
  /** Radice del volume dei knowledge graph (GRAPHS_DIR): quando presente, il
   * priming riceve il blocco GRAFO DEL CODICE e il run l'allowlist read-only di
   * graphify (vedi graph/agent-hint.ts). */
  graphsDir?: string;
  /** Radice del volume dei plugin del registro d'istanza (PLUGINS_DIR): quando
   * presente, ogni turno carica i plugin abilitati sul progetto (copia filtrata
   * per-run). Assente = nessun plugin, argv storico. */
  pluginsDir?: string;
  /** Turni massimi del run dell'agente per turno di chat. */
  maxTurns: number;
  /** Timeout (ms) del run dell'agente per turno di chat. */
  timeoutMs: number;
  /** Modello AI dei run (omesso = default del CLI). */
  model?: string;
  /** Risolutore di UN provider AI per id (iniettabile). Default loadProviderById. */
  loadProviderByIdFn?: typeof loadProviderById;
  /** Caricatore della catena di provider AI (iniettabile). Default loadProviderChain. */
  loadProviderChainFn?: typeof loadProviderChain;
  /** Tetto di domande dell'agente per VOCE (fase 7): stessa env del fix
   * (`AGENT_QUESTION_MAX_ROUNDS`), riusata di proposito — un solo budget di
   * "quante domande può fare l'agente" per istanza, non due manopole da
   * tenere allineate. Default DEFAULT_AGENT_QUESTION_MAX_ROUNDS. */
  questionMaxRounds?: number;
  /** Entry del server MCP `ask_user` (iniettabile per i test). Default
   * `askUserServerPath()`. */
  askUserServerPath?: string;
}

/** Forma attesa delle credenziali git decifrate (mirror di deep-dive.ts). */
const credentialsSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  token: z.string().min(1),
});

/**
 * Carica il MirrorProject del repository della sessione (credenziali decifrate).
 * Il repo esiste sempre (FK cascade: se cancellato, la sessione lo sarebbe già);
 * credenziali non decifrabili → throw (il turno fallisce senza retry).
 */
async function loadMirrorProject(
  deps: ChatTurnDeps,
  repositoryId: string,
): Promise<MirrorProject> {
  const [row] = await deps.db
    .select({ repository: repositories, account: gitAccounts })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(eq(repositories.id, repositoryId));
  if (!row) throw new Error(`chat turn: repository ${repositoryId} inesistente`);
  let credentials: z.infer<typeof credentialsSchema>;
  try {
    credentials = credentialsSchema.parse(
      JSON.parse(decrypt(row.account.encryptedCredentials, deps.encryptionKey)),
    );
  } catch {
    throw new Error(`chat turn: credenziali git del repository ${repositoryId} non decifrabili`);
  }
  return {
    provider: row.repository.provider,
    repoUrl: row.repository.repoUrl,
    defaultBranch: row.repository.defaultBranch,
    credentials,
  };
}

/**
 * Ultimi messaggi della chat (esclusa la domanda corrente, se ce n'è una: sul
 * ribootstrap di un turno di RIPRESA non c'è un messaggio utente da escludere
 * — la Q&A che ha innescato il turno è già parte della storia, scritta dai
 * turni precedenti), in ordine cronologico, cap a MAX_HISTORY_MESSAGES e
 * MAX_HISTORY_CHARS (tenendo i più recenti). Alimenta il priming del primo
 * turno / ri-bootstrap.
 */
async function loadRecentHistory(
  db: Db,
  itemId: string,
  currentUserMessageId?: string,
): Promise<CodeChatMessage[]> {
  const rows = await db
    .select({
      id: backlogChatMessages.id,
      role: backlogChatMessages.role,
      content: backlogChatMessages.content,
    })
    .from(backlogChatMessages)
    .where(eq(backlogChatMessages.itemId, itemId))
    .orderBy(asc(backlogChatMessages.createdAt), asc(backlogChatMessages.id));
  const prior =
    currentUserMessageId !== undefined ? rows.filter((r) => r.id !== currentUserMessageId) : rows;
  // Ultimi N messaggi, poi cap caratteri partendo dai più recenti.
  const lastN = prior.slice(-MAX_HISTORY_MESSAGES);
  const kept: CodeChatMessage[] = [];
  let chars = 0;
  for (let i = lastN.length - 1; i >= 0; i--) {
    const m = lastN[i]!;
    chars += m.content.length;
    if (chars > MAX_HISTORY_CHARS && kept.length > 0) break;
    kept.push({ role: m.role, content: m.content });
  }
  return kept.reverse();
}

/** Inserisce il messaggio `assistant` di errore i18n nella chat della voce. */
async function insertErrorMessage(db: Db, itemId: string, lang: Language): Promise<void> {
  await db.insert(backlogChatMessages).values({
    itemId,
    role: "assistant",
    content: t(lang, "backlog.codeTurnError"),
  });
}

/**
 * La risposta a una domanda in una riga di testo: l'etichetta dell'opzione
 * scelta (con la sua conseguenza) o il testo libero. GEMELLA di `renderAnswer`
 * in `apps/server/src/services/questions.ts` — non condivisa: sono due app
 * distinte (server/worker), e la funzione è tre righe di formattazione senza
 * stato, non vale la pena di un package a sé per non duplicarla.
 */
function renderBacklogAnswer(
  answer: AgentQuestionAnswer,
  options: { label: string; consequence?: string }[],
): string {
  if ("text" in answer) return answer.text;
  const option = options[answer.optionIndex];
  if (!option) return `#${answer.optionIndex + 1}`;
  return option.consequence ? `${option.label} — ${option.consequence}` : option.label;
}

/** Rende una domanda + le sue opzioni in un blocco leggibile per il messaggio
 * di chat che la referenzia (nessun bottone: quello lo rende il web, Task 7 —
 * questo testo è ciò che resta leggibile anche senza JS o a distanza di
 * giorni nella cronologia). */
function renderQuestionAsMessage(question: string, options: { label: string; consequence?: string }[]): string {
  const list = options
    .map((option, index) =>
      option.consequence ? `${index + 1}. ${option.label} — ${option.consequence}` : `${index + 1}. ${option.label}`,
    )
    .join("\n");
  return `${question}\n\n${list}`;
}

/**
 * Riconosce una violazione di vincolo unique di Postgres (23505) risalendo la
 * catena dei `cause`. GEMELLA di `isUniqueViolation` in
 * `apps/server/src/routes/shared.ts` — non condivisa (app diversa), stessa
 * ragione di `renderBacklogAnswer` qui sopra.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ((current as Error & { code?: unknown }).code === "23505") return true;
    current = current.cause;
  }
  return false;
}

/**
 * Esegue un turno della sessione di analisi sul codice (job già reclamato). Il
 * poller lo chiama DENTRO il serializer PER-ITEM (nessun `--resume` concorrente
 * sulla stessa sessione). Vedi il commento di modulo per il contratto.
 */
export async function runChatTurn(
  deps: ChatTurnDeps,
  job: BacklogJob,
  payload: BacklogChatTurnPayload,
): Promise<void> {
  const { db } = deps;

  // 1. Sessione del PAYLOAD: deve esistere, essere active e appartenere all'item
  //    del payload. Altrimenti no-op morbido (done, nessuna risposta).
  const [session] = await db
    .select({
      id: backlogCodeSessions.id,
      itemId: backlogCodeSessions.itemId,
      repositoryId: backlogCodeSessions.repositoryId,
      status: backlogCodeSessions.status,
      cliSessionId: backlogCodeSessions.cliSessionId,
    })
    .from(backlogCodeSessions)
    .where(eq(backlogCodeSessions.id, payload.sessionId));
  if (!session || session.status !== "active" || session.itemId !== payload.itemId) {
    // Cleanup MIRATO: se il worktree in registro appartiene PROPRIO a questa
    // sessione ora chiusa (DELETE/convert/scadenza), rimuovilo subito senza
    // aspettare lo sweep. Se invece appartiene a un'ALTRA sessione (chiusura +
    // riapertura) NON toccarlo: è il worktree valido di quella nuova sessione.
    const stale = deps.registry.get(payload.itemId);
    if (stale && session && stale.sessionId === session.id) {
      await deps.registry.remove(payload.itemId).catch(() => undefined);
    }
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId, sessionId: payload.sessionId },
      "[backlog] chat turn: sessione non più attiva o mismatch, no-op",
    );
    return;
  }

  // 2. Voce (documento + metadati): inesistente/archiviata/convertita → no-op.
  const [item] = await db
    .select({
      title: backlogItems.title,
      document: backlogItems.document,
      status: backlogItems.status,
      effort: backlogItems.effort,
      risk: backlogItems.risk,
      urgency: backlogItems.urgency,
    })
    .from(backlogItems)
    .where(eq(backlogItems.id, payload.itemId));
  if (!item || item.status === "archived" || item.status === "converted") {
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId },
      "[backlog] chat turn: voce inesistente/archiviata/convertita, no-op",
    );
    return;
  }

  // 3. Cosa ha innescato il turno: un NUOVO messaggio utente, oppure la
  //    RISPOSTA appena data a una domanda dell'agente (fase 7, Task 6). Le due
  //    forme del payload sono mutuamente esclusive per costruzione (`.strict()`
  //    a monte, `backlogChatTurnPayloadSchema` in packages/shared).
  let userMessageContent: string | null = null;
  let answeredQuestion:
    | { question: string; options: { label: string; consequence?: string }[]; answer: AgentQuestionAnswer }
    | null = null;
  if ("userMessageId" in payload) {
    const [userMsg] = await db
      .select({ itemId: backlogChatMessages.itemId, role: backlogChatMessages.role, content: backlogChatMessages.content })
      .from(backlogChatMessages)
      .where(eq(backlogChatMessages.id, payload.userMessageId));
    if (!userMsg || userMsg.itemId !== payload.itemId || userMsg.role !== "user") {
      deps.logger.warn(
        { jobId: job.id, userMessageId: payload.userMessageId },
        "[backlog] chat turn: messaggio utente mancante/incoerente, no-op",
      );
      return;
    }
    userMessageContent = userMsg.content;
  } else {
    // La domanda deve appartenere a QUESTA voce ed essere DAVVERO risposta:
    // `answerBacklogQuestion` accoda il job dentro la stessa transazione che
    // scrive la risposta, quindi in condizioni normali arriva sempre così —
    // ma un job orfano (rilancio manuale, corsa con una revoca futura) non
    // deve far esplodere il turno: no-op morbido, come le altre guardie qui.
    const [question] = await db
      .select({
        backlogItemId: backlogQuestions.backlogItemId,
        question: backlogQuestions.question,
        options: backlogQuestions.options,
        answer: backlogQuestions.answer,
        answeredAt: backlogQuestions.answeredAt,
      })
      .from(backlogQuestions)
      .where(eq(backlogQuestions.id, payload.answeredQuestionId));
    if (!question || question.backlogItemId !== payload.itemId || question.answeredAt === null || question.answer === null) {
      deps.logger.warn(
        { jobId: job.id, answeredQuestionId: payload.answeredQuestionId },
        "[backlog] chat turn: domanda risposta mancante/incoerente, no-op",
      );
      return;
    }
    answeredQuestion = { question: question.question, options: question.options, answer: question.answer };
  }

  // 4. Lingua dei contenuti + provider AI (pinned del progetto o chain[0]).
  const lang = await getContentLanguage(db);
  const aiProviderId = await loadProjectAiProviderId(db, job.projectId);
  const provider = await resolveBacklogProvider(deps, aiProviderId);

  // 5. Entry del registro o (ri-)bootstrap. Un handle di un'ALTRA sessione (id
  //    diverso: chiusura+riapertura mentre il vecchio worktree era ancora in
  //    registro) va rimosso e riaperto da capo — mai riusare il vecchio
  //    cliSessionId (mischierebbe i contesti).
  let entry = deps.registry.get(payload.itemId);
  if (entry && entry.sessionId !== session.id) {
    await deps.registry.remove(payload.itemId);
    entry = undefined;
  }
  if (!entry) {
    const mirrorProject = await loadMirrorProject(deps, session.repositoryId);
    // Apertura DENTRO il serializer per-progetto: niente corsa col fetch --prune
    // del mirror condiviso (fix/doc-gen/deep-dive dello stesso progetto).
    const branchName = `stubwise/backlog-code-${session.id}`;
    const handle = await deps.serializer.run(job.projectId, () =>
      deps.mirrors.openWorktree(mirrorProject, branchName),
    );
    const opened: CodeSessionEntry = {
      sessionId: session.id,
      repositoryId: session.repositoryId,
      dir: handle.dir,
      // Ri-bootstrap ⇒ NUOVA sessione CLI: si IGNORA il cli_session_id storico in
      // DB (worktree e sessione CLI precedenti persi) → primo run senza --resume.
      cliSessionId: null,
      remove: handle.remove,
    };
    deps.registry.set(payload.itemId, opened);
    entry = opened;
  }

  // 6. Cablaggio del tool `ask_user` per QUESTO run (fase 7, Task 6): round =
  // domande già poste su questa VOCE (di qualunque esito) + 1, stesso schema
  // di conteggio del fix (`questionRound` in pipeline/fix.ts) applicato qui
  // per-item invece che per-job. Entry del server MCP assente (sviluppo con
  // `tsx`, build parziale) → tool non cablato, un solo avviso nel log: un
  // server MCP fantasma fallirebbe in silenzio.
  const askUserRound =
    ((await db.select({ value: count() }).from(backlogQuestions).where(eq(backlogQuestions.backlogItemId, payload.itemId)))[0]
      ?.value ?? 0) + 1;
  const questionMaxRounds = deps.questionMaxRounds ?? DEFAULT_AGENT_QUESTION_MAX_ROUNDS;
  const askUser = buildAskUserRunConfig({
    jobId: job.id,
    serverPath: deps.askUserServerPath ?? askUserServerPath(),
    round: askUserRound,
    maxRounds: questionMaxRounds,
  });
  if (!askUser.enabled) {
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId },
      `[backlog] chat turn: tool ask_user non disponibile (entry '${askUser.serverPath}' assente): questo turno non potrà fare domande`,
    );
  }
  const askUserPromptOpt = askUser.enabled ? { askUser: { round: askUserRound, maxRounds: questionMaxRounds } } : {};

  // 7. Prompt: PRIMING (nessuna sessione CLI ancora, o ribootstrap) o RIPRESA
  // (--resume): FOLLOWUP per un nuovo messaggio utente, o l'annuncio della
  // risposta appena arrivata per un turno che riprende dopo una domanda.
  // Grafo del repo sul volume (fase 2a graphify): citato nel priming (i turni
  // successivi ereditano il contesto dalla sessione CLI) e allowlistato su OGNI
  // run, anche in --resume — l'allowlist non persiste nella sessione, e vale
  // anche per `ask_user` (Task 6, vedi sopra): entrambi ripassati a ogni run.
  const graphJsonPath =
    deps.graphsDir !== undefined
      ? resolveRepoGraphJson(deps.graphsDir, entry.repositoryId)
      : null;
  const resuming = entry.cliSessionId !== null;
  let prompt: string;
  if (answeredQuestion !== null) {
    const renderedAnswer = renderBacklogAnswer(answeredQuestion.answer, answeredQuestion.options);
    prompt = resuming
      ? buildCodeChatAnswerPrompt(
          { question: answeredQuestion.question, answer: renderedAnswer },
          askUserPromptOpt.askUser,
        )
      : buildCodeChatPrimingPrompt({
          title: item.title,
          document: item.document,
          effort: item.effort,
          risk: item.risk,
          urgency: item.urgency,
          history: await loadRecentHistory(db, payload.itemId),
          question: renderAnsweredBacklogQuestion(answeredQuestion.question, renderedAnswer),
          language: lang,
          ...(graphJsonPath !== null ? { graphJsonPath } : {}),
          ...askUserPromptOpt,
        });
  } else {
    prompt = resuming
      ? buildCodeChatFollowupPrompt(userMessageContent!, askUserPromptOpt.askUser)
      : buildCodeChatPrimingPrompt({
          title: item.title,
          document: item.document,
          effort: item.effort,
          risk: item.risk,
          urgency: item.urgency,
          history: await loadRecentHistory(db, payload.itemId, "userMessageId" in payload ? payload.userMessageId : undefined),
          question: userMessageContent!,
          language: lang,
          ...(graphJsonPath !== null ? { graphJsonPath } : {}),
          ...askUserPromptOpt,
        });
  }

  // 7. Run dell'agente nel worktree read-only (plan mode). Errore/timeout →
  //    messaggio di errore + throw (poller: failed senza retry).
  // I plugin abilitati sul progetto sono preparati per OGNI turno (copia filtrata
  // in una dir temporanea fuori dal worktree, liberata nel `finally`): il flag è
  // session-scoped nel CLI, quindi anche un turno in `--resume` deve ripassarlo.
  const runPlugins = await openRunPlugins(db, {
    projectId: job.projectId,
    ...(deps.pluginsDir !== undefined ? { pluginsDir: deps.pluginsDir } : {}),
    log: (message) => deps.logger.warn({ jobId: job.id, itemId: payload.itemId }, message),
  });
  // Allowlist del run: grafo (se c'è) + tool `ask_user` (se cablato). Entrambi
  // RIPASSATI a ogni run — nessuno dei due persiste nella sessione CLI.
  const chatTools = [...(graphJsonPath !== null ? GRAPHIFY_AGENT_ALLOWED_TOOLS : []), ...askUser.tools];
  // La parent dir del file-bridge NON è la cwd del run qui (a differenza del
  // fix, che gira dentro `withProjectWorktrees` con quella stessa dir): la cwd
  // è il worktree persistente della sessione, il bridge vive altrove per
  // path assoluto (l'env `ASK_USER_FILE` lo dice al tool, indipendentemente
  // dalla cwd del processo). `withProjectWorktrees` normalmente crea e ripulisce
  // questa dir per il fix; qui non passandoci mai, tocca a NOI crearla PRIMA
  // del run (altrimenti il tool non troverebbe dove scrivere) e ripulirla
  // DOPO, nello stesso `finally` dei plugin.
  if (askUser.enabled) await mkdir(askUser.parentDir, { recursive: true, mode: 0o700 });
  let output: string;
  let cliSessionId: string | undefined;
  let capturedQuestion: AskUserPayload | null = null;
  try {
    const result = await deps.runner.run({
      cwd: entry.dir,
      prompt,
      ...(chatTools.length > 0 ? { allowedTools: chatTools } : {}),
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.timeoutMs,
      ...(provider !== undefined ? { provider } : {}),
      ...(entry.cliSessionId !== null ? { resumeSessionId: entry.cliSessionId } : {}),
      ...askUser.mcpOpt,
      ...runPlugins.options,
    });
    if (result.exitCode !== 0) {
      await insertErrorMessage(db, payload.itemId, lang);
      throw new Error(`chat turn: agente uscito con exit ${result.exitCode}`);
    }
    output = result.output;
    cliSessionId = result.sessionId;

    // Domanda dell'agente (fase 7, Task 6): file-bridge letto SOLO se il tool
    // era cablato. Due decisioni conservative, gemelle di `captureQuestion` in
    // pipeline/fix.ts: file MALFORMATO (JSON rotto, schema violato, o —
    // caso nuovo qui — una domanda già aperta sulla voce, corsa rara ma
    // possibile) → si logga e si prosegue in prosa con l'output del turno;
    // domanda + testo nello stesso turno → vince la domanda, il testo scartato
    // resta nel log (il modello ha ignorato "termina il turno subito").
    if (askUser.enabled) {
      const read = await readAskUserQuestion(askUser.filePath);
      if (read.kind === "question") {
        capturedQuestion = read.payload;
        if (output.trim() !== "") {
          deps.logger.warn(
            { jobId: job.id, itemId: payload.itemId },
            "[backlog] chat turn: l'agente ha posto una domanda e prodotto testo nello stesso turno: vince la domanda, il testo viene scartato",
          );
        }
      } else if (read.kind === "malformed") {
        deps.logger.warn(
          { jobId: job.id, itemId: payload.itemId, reason: read.reason },
          "[backlog] chat turn: domanda dell'agente ignorata, file-bridge non valido: proseguo in prosa",
        );
      }
    }
  } catch (err) {
    // Timeout/spawn error: messaggio di errore (se non già inserito sopra) e
    // rilancio. insertErrorMessage è idempotente-abbastanza (un secondo messaggio
    // non è dannoso), ma per l'exit≠0 l'abbiamo già inserito e ri-lanciato: qui
    // arriva solo su throw del runner (timeout/spawn), che NON ha inserito nulla.
    if (!(err instanceof Error && err.message.startsWith("chat turn: agente uscito"))) {
      await insertErrorMessage(db, payload.itemId, lang).catch(() => undefined);
    }
    throw err;
  } finally {
    // Il turno è finito (riuscito o no): la copia dei plugin non serve più.
    await runPlugins.cleanup();
    // Idem per la parent dir del file-bridge: letta (se c'era qualcosa) o no,
    // non deve sopravvivere al turno — un residuo bloccherebbe SOLO il turno
    // successivo di QUESTA stessa voce se il job.id si ripetesse, il che non
    // succede mai (ogni turno è un job nuovo), ma resta un file temporaneo da
    // non lasciare in giro sul filesystem del worker.
    if (askUser.enabled) await rm(askUser.parentDir, { recursive: true, force: true });
  }

  // 8. Successo: aggiorna il cli_session_id se il CLI l'ha riportato (altrimenti
  //    fallback ri-priming al prossimo turno, warning), inserisci l'assistant e
  //    tocca last_activity_at. Il cli_session_id in-memory guida il --resume.
  if (cliSessionId !== undefined) {
    entry.cliSessionId = cliSessionId;
  } else if (!resuming) {
    // Priming senza session_id: il prossimo turno ri-primerà (degradato).
    deps.logger.warn(
      { jobId: job.id, itemId: payload.itemId },
      "[backlog] chat turn: session_id assente nel risultato del CLI, il prossimo turno ri-priming",
    );
  }

  // Se l'agente ha posto una domanda, PROVA a scriverla: l'unique parziale
  // (`backlog_questions_open_item_unique`) può rifiutarla se — per una corsa
  // genuinamente possibile, i turni sono serializzati per-item ma non lo sono
  // rispetto a una risposta/dismiss appena arrivata sulla STESSA voce da
  // un'altra strada — c'è già una domanda aperta. In quel caso si degrada
  // come un file-bridge malformato: si prosegue in prosa con `output` (che
  // qui è quasi certamente vuoto, perché l'agente ha già terminato il turno
  // per la domanda scartata).
  let questionMessageContent = output;
  if (capturedQuestion !== null) {
    try {
      await db.transaction((tx) =>
        tx.insert(backlogQuestions).values({
          backlogItemId: payload.itemId,
          question: capturedQuestion!.question,
          options: capturedQuestion!.options,
          ...(capturedQuestion!.recommendedIndex !== undefined
            ? { recommendedIndex: capturedQuestion!.recommendedIndex }
            : {}),
          allowFreeText: capturedQuestion!.allowFreeText,
        }),
      );
      questionMessageContent = renderQuestionAsMessage(capturedQuestion.question, capturedQuestion.options);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      deps.logger.warn(
        { jobId: job.id, itemId: payload.itemId },
        "[backlog] chat turn: la voce ha già una domanda aperta, quella nuova è stata scartata: proseguo in prosa",
      );
    }
  }

  await db.transaction(async (tx) => {
    await tx.insert(backlogChatMessages).values({
      itemId: payload.itemId,
      // La domanda dell'agente arriva come `assistant`, stessa forma della
      // risposta in prosa: chi legge la cronologia vede comunque "cosa ha
      // detto l'agente". Il pannello a bottoni (Task 7) si aggancia alla
      // domanda ANCORA APERTA della voce, non a un campo su questo messaggio.
      role: "assistant",
      content: questionMessageContent,
    });
    // cli_session_id + last_activity_at, status-guarded su active: se la sessione
    // è stata chiusa durante il run (DELETE), l'UPDATE tocca 0 righe (la risposta
    // resta comunque in chat).
    await tx
      .update(backlogCodeSessions)
      .set({
        ...(cliSessionId !== undefined ? { cliSessionId } : {}),
        lastActivityAt: new Date(),
      })
      .where(and(eq(backlogCodeSessions.id, payload.sessionId), eq(backlogCodeSessions.status, "active")));
  });
}
