import {
  backlogChatMessages,
  backlogCodeSessions,
  backlogItems,
  decrypt,
  gitAccounts,
  repositories,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { BacklogChatTurnPayload, Language } from "@stubwise/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { MirrorManager, MirrorProject } from "../git/mirrors.js";
import type { ProjectSerializer } from "../handler.js";
import { loadProviderById, loadProviderChain } from "../providers/chain.js";
import { getContentLanguage } from "../settings.js";
import type { CodeSessionEntry, CodeSessionRegistry } from "./code-session.js";
import type { BacklogJob, BacklogLogger } from "./poller.js";
import {
  buildCodeChatFollowupPrompt,
  buildCodeChatPrimingPrompt,
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
 * Ultimi messaggi della chat (esclusa la domanda corrente), in ordine
 * cronologico, cap a MAX_HISTORY_MESSAGES e MAX_HISTORY_CHARS (tenendo i più
 * recenti). Alimenta il priming del primo turno / ri-bootstrap.
 */
async function loadRecentHistory(
  db: Db,
  itemId: string,
  currentUserMessageId: string,
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
  const prior = rows.filter((r) => r.id !== currentUserMessageId);
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

  // 3. Messaggio utente che ha innescato il turno.
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
      lastUsed: Date.now(),
      remove: handle.remove,
    };
    deps.registry.set(payload.itemId, opened);
    entry = opened;
  }

  // 6. Prompt: PRIMING (nessuna sessione CLI ancora) o FOLLOWUP (--resume).
  const resuming = entry.cliSessionId !== null;
  const prompt = resuming
    ? buildCodeChatFollowupPrompt(userMsg.content)
    : buildCodeChatPrimingPrompt({
        title: item.title,
        document: item.document,
        effort: item.effort,
        risk: item.risk,
        urgency: item.urgency,
        history: await loadRecentHistory(db, payload.itemId, payload.userMessageId),
        question: userMsg.content,
        language: lang,
      });

  // 7. Run dell'agente nel worktree read-only (plan mode). Errore/timeout →
  //    messaggio di errore + throw (poller: failed senza retry).
  let output: string;
  let cliSessionId: string | undefined;
  try {
    const result = await deps.runner.run({
      cwd: entry.dir,
      prompt,
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      permissionMode: "plan",
      maxTurns: deps.maxTurns,
      timeoutMs: deps.timeoutMs,
      ...(provider !== undefined ? { provider } : {}),
      ...(entry.cliSessionId !== null ? { resumeSessionId: entry.cliSessionId } : {}),
    });
    if (result.exitCode !== 0) {
      await insertErrorMessage(db, payload.itemId, lang);
      throw new Error(`chat turn: agente uscito con exit ${result.exitCode}`);
    }
    output = result.output;
    cliSessionId = result.sessionId;
  } catch (err) {
    // Timeout/spawn error: messaggio di errore (se non già inserito sopra) e
    // rilancio. insertErrorMessage è idempotente-abbastanza (un secondo messaggio
    // non è dannoso), ma per l'exit≠0 l'abbiamo già inserito e ri-lanciato: qui
    // arriva solo su throw del runner (timeout/spawn), che NON ha inserito nulla.
    if (!(err instanceof Error && err.message.startsWith("chat turn: agente uscito"))) {
      await insertErrorMessage(db, payload.itemId, lang).catch(() => undefined);
    }
    throw err;
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
  entry.lastUsed = Date.now();

  await db.transaction(async (tx) => {
    await tx.insert(backlogChatMessages).values({
      itemId: payload.itemId,
      role: "assistant",
      content: output,
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
