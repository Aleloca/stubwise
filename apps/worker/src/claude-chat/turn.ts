import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  agentSessionInputs,
  claudeConversations,
  issueChatToolToken,
  monthlyCostUsd,
  revokeChatToolToken,
  users,
  type Db,
} from "@stubwise/db";
import { t } from "@stubwise/i18n";
import type { ClaudeConversationContext } from "@stubwise/shared";
import { mergeDisallowedTools, sensitiveReadDenyRules } from "../agent/read-scope.js";
import { AgentRunCancelledError, type AgentRunOptions, type AgentRunResult, type AgentRunner } from "../agent/runner.js";
import { NoAccountAvailableError, runBacklogWithProviders } from "../backlog/provider.js";
import {
  backToPending,
  claimOpening,
  echoed,
  markUndelivered,
  noticeInTranscript,
  recentTranscript,
} from "../backlog/refine/turn.js";
import { loadMonthlyBudgetUsd } from "../pipeline/job-outcomes.js";
import type { ResolvedProvider } from "../providers/chain.js";
import { isLimitError } from "../providers/limit.js";
import { limitTextOfRun, type SelectDeps } from "../providers/select.js";
import { claudeChatSession } from "../sessions/owners.js";
import { getContentLanguage } from "../settings.js";
import { buildChatMcpConfig, chatServerPath, type ChatBridge } from "./bridge.js";
import { ensureChatCwd, type ChatCliPaths } from "./cli-dir.js";
import { buildChatPrimingPrompt, buildChatResumePrompt } from "./prompts.js";

/**
 * UN turno di una conversazione libera con Claude (chat, fetta 1). Stessa
 * forma del turno di refinement (`backlog/refine/turn.ts`): nasce dall'input
 * d'apertura scelto dallo scheduler, lo reclama subito prima del run, riprende
 * la conversazione CLI con `--resume` (un `--resume` rifiutato → un tentativo
 * col prompt d'avvio), e un messaggio che il CLI non ha mai preso non torna in
 * coda per sempre (`turn_failed`/`stdin_closed`/`session_not_live`).
 *
 * Ciò che è suo: nessun worktree né repository né plugin — la cwd è una
 * cartella VUOTA per turno, i tool del file system sono negati, e l'unica cosa
 * che Claude può fare è leggere Stubwise coi tool `stubwise_chat`, attraverso
 * il ponte, con il TOKEN DEL TURNO: emesso qui (hash nel DB, scadenza ≈ la
 * durata del turno), legato alla sessione e all'autore, revocato nel
 * `finally`. Il token non entra mai nel prompt, nei log, negli eventi né
 * nell'env del server MCP (`docs/invariants/second-factor.md`).
 *
 * Budget mensile sforato: il messaggio diventa `budget_exceeded`, per tutti
 * (una conversazione non ha un progetto, quindi nessun `plans.approve` la
 * scavalca; lo stesso fa il server, che rifiuta già il messaggio con 409).
 */

/**
 * I tool NATIVI del CLI negati in ogni turno. La difesa vera è `--tools ""`
 * (`builtinTools: ""`: nessun tool nativo esiste nel turno — golden del 10 nov
 * 2026: senza, il CLI 2.1.322 esponeva anche `ToolSearch`, `CronCreate`,
 * `SendMessage`, `Workflow`…); questo elenco è la bretella sopra, insieme
 * all'allowlist chiusa e alla cwd vuota. Esportata per gli scenari golden.
 */
export const CHAT_DENIED_BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "NotebookRead",
  "Task",
  "Agent",
  "Skill",
  "TodoWrite",
  "KillShell",
  "BashOutput",
] as const;

export function chatDisallowedTools(): string[] {
  return mergeDisallowedTools([...CHAT_DENIED_BUILTIN_TOOLS], sensitiveReadDenyRules());
}

/** Margine della scadenza del token oltre il timeout del turno (pausa, coda di chiusura). */
const TOKEN_TTL_MARGIN_MS = 60_000;

export interface ChatTurnDeps {
  db: Db;
  runner: AgentRunner;
  bridge: ChatBridge;
  model?: string;
  maxTurns: number;
  turnTimeoutMs: number;
  chatServerPath?: string;
  /** Radici di cwd e trascrizioni del CLI (test). */
  cliPaths?: ChatCliPaths;
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  select: SelectDeps;
  log: (m: string) => void;
}

export type ChatTurnOutcome = "completed" | "cancelled" | "failed" | "skipped";

const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function overBudget(deps: ChatTurnDeps): Promise<boolean> {
  const limit = await loadMonthlyBudgetUsd(deps.db);
  if (limit === null) return false;
  return (await (deps.monthlyCostUsdFn ?? monthlyCostUsd)(deps.db)) >= limit;
}

export async function runChatTurn(
  deps: ChatTurnDeps,
  input: { sessionId: string; inputId: string; signal: AbortSignal },
): Promise<ChatTurnOutcome> {
  const { db, log } = deps;
  const sid = input.sessionId;

  // 0. Il messaggio d'apertura, ancora `pending`.
  const [opening] = await db
    .select()
    .from(agentSessionInputs)
    .where(and(eq(agentSessionInputs.id, input.inputId), eq(agentSessionInputs.sessionId, sid)));
  if (!opening || opening.status !== "pending") return "skipped";

  // 1. Conversazione viva e messaggio del suo autore (il server lo garantisce
  //    già: qui è la rete, e il token del turno è dell'AUTORE, mai di altri).
  const [conv] = await db
    .select({ conversation: claudeConversations, displayName: users.displayName, email: users.email })
    .from(claudeConversations)
    .innerJoin(users, eq(users.id, claudeConversations.ownerId))
    .where(eq(claudeConversations.sessionId, sid));
  if (!conv || conv.conversation.archivedAt !== null || opening.authorUserId !== conv.conversation.ownerId) {
    await markUndelivered(db, sid, opening.id, "session_not_live", ["pending"]);
    return "skipped";
  }
  const ownerId = conv.conversation.ownerId;

  // 2. Budget mensile.
  if (await overBudget(deps)) {
    await markUndelivered(db, sid, opening.id, "budget_exceeded", ["pending"]);
    return "skipped";
  }

  // L'entry del server MCP compilata: senza, nessun turno (fail-closed). Un
  // turno senza tool risponderebbe senza poter leggere, cioè inventando.
  const serverPath = deps.chatServerPath ?? chatServerPath();
  if (!existsSync(serverPath)) {
    log(`[chat] entry MCP assente (${serverPath}): nessun turno per la sessione ${sid}`);
    await markUndelivered(db, sid, opening.id, "turn_failed", ["pending"]);
    return "failed";
  }

  let resumeRejected = false;
  const saveCliSessionId = (cliSessionId: string | null) =>
    db
      .update(claudeConversations)
      .set({ cliSessionId, ...(cliSessionId === null ? { cliSessionStartedAt: null } : {}) })
      .where(eq(claudeConversations.sessionId, sid));
  try {
    if (input.signal.aborted) return "cancelled";
    // 3. La cwd della conversazione: DETERMINISTICA (il CLI indicizza
    //    `--resume` per cwd) e vuota — nessun file da leggere, nessun
    //    `.claude/` o `.mcp.json` intorno (e `--setting-sources ""` comunque).
    //    Resta fra i turni; la tolgono l'eliminazione e la potatura.
    const cwd = await ensureChatCwd(sid, deps.cliPaths);
    const disallowedTools = chatDisallowedTools();

    const priming = async () =>
      buildChatPrimingPrompt(
        {
          language: await getContentLanguage(db),
          authorName: conv.displayName?.trim() || conv.email.split("@")[0]!,
          context: (conv.conversation.contextRef as ClaudeConversationContext | null) ?? null,
          toolsAvailable: true,
          recentTranscript: await recentTranscript(db, sid, opening.id),
          // La continuazione di una pubblica (F5.3): la prosa leggibile dell'originale.
          origin: conv.conversation.originTranscript ?? null,
        },
        opening.text,
      );
    const session = claudeChatSession(sid, randomUUID());
    /**
     * UN tentativo, col SUO token e il SUO segreto del ponte: un tentativo che
     * ne segue un altro (account al limite, `--resume` rifiutato) non eredita
     * un token che stava per scadere, e nessuno resta vivo dopo il tentativo.
     */
    const attempt = async (
      resumeSessionId: string | null,
      prompt: string,
      provider: ResolvedProvider | undefined,
    ): Promise<AgentRunResult> => {
      const token = await issueChatToolToken(db, {
        sessionId: sid,
        userId: ownerId,
        ttlMs: deps.turnTimeoutMs + TOKEN_TTL_MARGIN_MS,
      });
      const grant = deps.bridge.grant({ sessionId: sid, serverToken: token });
      try {
        const mcp = buildChatMcpConfig(deps.bridge, grant, serverPath);
        if (mcp === null) throw new Error("entry MCP della chat sparita");
        return await deps.runner.run({
          cwd,
          prompt,
          permissionMode: "default",
          allowedTools: [...mcp.tools],
          disallowedTools,
          settingSources: "",
          // Nessun tool nativo: restano solo quelli di `stubwise_chat`.
          builtinTools: "",
          maxTurns: deps.maxTurns,
          timeoutMs: deps.turnTimeoutMs,
          ...(deps.model !== undefined ? { model: deps.model } : {}),
          ...(provider !== undefined ? { provider } : {}),
          ...(resumeSessionId !== null ? { resumeSessionId } : {}),
          mcpConfig: mcp.mcpConfig,
          session,
          openingInput: { inputId: opening.id, text: opening.text, authorUserId: opening.authorUserId },
          signal: input.signal,
          usage: { operation: "claude_chat", projectId: null },
        } satisfies AgentRunOptions);
      } finally {
        grant.revoke();
        await revokeChatToolToken(db, token).catch((e: unknown) => {
          // Mai il token nel log: scade comunque da sé.
          log(`[chat] token del turno della sessione ${sid} non revocato (scade da sé): ${describeError(e)}`);
        });
      }
    };

    const stored = conv.conversation.cliSessionId;
    const context = (conv.conversation.contextRef as ClaudeConversationContext | null) ?? null;
    const firstPrompt = stored !== null ? buildChatResumePrompt(opening.text, context) : await priming();

    // 5. CLAIM, subito prima del run.
    if (input.signal.aborted) return "cancelled";
    if (!(await claimOpening(db, opening.id, ["pending"]))) return "skipped";

    // 6. Run per account, con UN nuovo tentativo se il --resume è rifiutato.
    type ProviderAttempt = { kind: "run"; result: AgentRunResult } | { kind: "skipped" };
    let firstAccount = true;
    const outcome = await runBacklogWithProviders<ProviderAttempt>(
      deps,
      null,
      "claude-chat",
      async (provider) => {
        if (!firstAccount && !(await claimOpening(db, opening.id, ["pending", "delivered"]))) {
          return { kind: "skipped" };
        }
        firstAccount = false;
        const resumeId = resumeRejected ? null : stored;
        let res = await attempt(resumeId, resumeId !== null || stored === null ? firstPrompt : await priming(), provider);
        if (isLimitError(res)) return { kind: "run", result: res };
        if (resumeId !== null && res.exitCode !== 0 && !(await echoed(db, sid, opening.id))) {
          log(`[chat] --resume rifiutato per la sessione ${sid}: riparto col prompt d'avvio`);
          resumeRejected = true;
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
      const keep = result.sessionId ?? (resumeRejected ? null : stored);
      if (keep !== stored) {
        await db
          .update(claudeConversations)
          .set({ cliSessionId: keep, cliSessionStartedAt: keep === null ? null : sql`now()` })
          .where(eq(claudeConversations.sessionId, sid));
      }
      resumeRejected = false;
      throw new Error(`agente uscito con exit ${result.exitCode}`);
    }

    // 7. Riuscito.
    const fallbackId = resumeRejected ? null : stored;
    resumeRejected = false;
    const nextId = result.sessionId ?? fallbackId;
    await db
      .update(claudeConversations)
      .set({
        cliSessionId: nextId,
        // Una sessione del CLI NUOVA ha la sua data: la potatura la scarta dopo 14 giorni.
        ...(nextId !== stored ? { cliSessionStartedAt: nextId === null ? null : sql`now()` } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(claudeConversations.sessionId, sid));
    if (!(await echoed(db, sid, opening.id))) {
      log(`[chat] turno della sessione ${sid} riuscito senza eco dell'input ${opening.id}: marcato turn_failed`);
      await markUndelivered(db, sid, opening.id, "turn_failed", ["pending", "delivered"]).catch((e: unknown) => {
        log(`[chat] input ${opening.id} non marcato turn_failed: ${describeError(e)}`);
      });
    }
    return "completed";
  } catch (error) {
    if (error instanceof AgentRunCancelledError) {
      if (!(await echoed(db, sid, opening.id).catch(() => true))) {
        if (input.signal.aborted) {
          await backToPending(db, sid, opening.id).catch((e: unknown) => {
            log(`[chat] input ${opening.id} non riportato in coda: ${describeError(e)}`);
          });
        } else {
          await markUndelivered(db, sid, opening.id, "stdin_closed", ["pending", "delivered"]).catch((e: unknown) => {
            log(`[chat] input ${opening.id} non marcato stdin_closed: ${describeError(e)}`);
          });
        }
      }
      return "cancelled";
    }
    log(`[chat] turno della sessione ${sid} fallito: ${describeError(error)}`);
    if (error instanceof NoAccountAvailableError) {
      await noticeInTranscript(db, sid, t(await getContentLanguage(db), "backlog.noAccountAvailable")).catch(
        (e: unknown) => log(`[chat] avviso «nessun account» non scritto nella sessione ${sid}: ${describeError(e)}`),
      );
    }
    const taken = await echoed(db, sid, opening.id).catch(() => false);
    if (!taken) {
      await markUndelivered(db, sid, opening.id, "turn_failed", ["pending", "delivered"]).catch((e: unknown) => {
        log(`[chat] input ${opening.id} non marcato turn_failed: ${describeError(e)}`);
      });
    }
    return "failed";
  } finally {
    if (resumeRejected) {
      await saveCliSessionId(null).catch((e: unknown) => {
        log(`[chat] cli_session_id della sessione ${sid} non azzerato: ${describeError(e)}`);
      });
    }
  }
}
