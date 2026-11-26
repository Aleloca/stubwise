import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { emailMessages, monthlyCostUsd, type Db } from "@stubwise/db";
import { aiBudgetState, waitingCandidates } from "@stubwise/notifications";
import { NATIVE_TOOLS } from "../agent/native-tools.js";
import type { AgentRunner } from "../agent/runner.js";
import { isQuotaWait, limitTextOfRun, runWithProviders, type SelectDeps } from "../providers/select.js";
import { parseAgentJson, textFromRun } from "../agent/text.js";
import { countClassifyRunsSince, DEFAULT_GMAIL_MAX_PER_DAY, EMAIL_DELIMITER_END, EMAIL_DELIMITER_START } from "./classify.js";
import { replyContext, replyInstruction, replyJudgmentOutputSchema, REPLY_FIELD_SHAPE } from "./reply-judgment.js";

/**
 * J2 — il giudizio «serve una MIA risposta?» A PARTE (area 8, «Clienti in
 * attesa»), SOLO per i thread che passano il taglio INTERO (24 ore comprese:
 * un thread a cui si risponde entro un giorno non costa niente) e il cui
 * ultimo messaggio non ha ancora un giudizio: la risposta di un collega (un
 * contesto, mai classificato), i messaggi di prima di questa fetta, quelli
 * che la classificazione ha saltato. Gira anche con le proposte spente
 * (W-3 = a): non è una proposta né una card.
 *
 * Stessa dottrina della classificazione: Haiku via TrackingAgentRunner
 * (`UsageTag` suo), nel budget, testo della posta delimitato, nessuno
 * strumento. Idempotente: si scrive sul messaggio giudicato, vale finché è
 * l'ultimo; al più 2 tentativi; il budget esaurito non consuma tentativi.
 * Mai la casella di un altro: SOLO i messaggi della casella giudicata.
 */

export const REPLY_JUDGMENT_MAX_ATTEMPTS = 2;
export const REPLY_JUDGMENT_MAX_PER_TICK = 10;
const CUTOFF_MS = 24 * 3_600_000;
const THREAD_MESSAGES = 10;
const MESSAGE_CHARS = 2_000;

export interface ReplyJudgeDeps {
  db: Db;
  runner: AgentRunner;
  select: SelectDeps;
  model?: string;
  lang?: "it" | "en";
  now?: () => Date;
  maxPerTick?: number;
  /**
   * Il tetto giornaliero della casella (`GMAIL_MAX_PER_DAY`), CONDIVISO con
   * la classificazione (`countClassifyRunsSince` conta entrambe); omesso =
   * {@link DEFAULT_GMAIL_MAX_PER_DAY}, `0` = nessun tetto.
   */
  maxPerDay?: number;
  monthlyCostUsdFn?: (db: Db) => Promise<number>;
  log?: (m: string) => void;
}

/** Un testo non fidato non apre né chiude il blocco dell'email. */
const untrusted = (text: string) => text.replace(/<<</g, "‹‹‹").replace(/>>>/g, "›››");

export function buildReplyJudgmentPrompt(input: {
  mailbox: string;
  colleagues: readonly string[];
  language: "it" | "en";
  messages: { from: string; at: Date; text: string }[];
}): string {
  return [
    "You read ONE email conversation of a mailbox and answer with JSON only, no prose.",
    `OUTPUT (JSON only): {${REPLY_FIELD_SHAPE.replace(/^"reply":/, "").slice(1, -1)}}`,
    "",
    replyInstruction({ ...input, target: "whole" }),
    "",
    EMAIL_DELIMITER_START,
    "The conversation (oldest first):",
    ...input.messages.map((m) => `- [${m.at.toISOString().slice(0, 16)}] ${untrusted(m.from)}: ${untrusted(m.text)}`),
    EMAIL_DELIMITER_END,
  ].join("\n");
}

/** Giudica i thread candidati di UNA casella. Restituisce quanti giudizi ha scritto. */
export async function judgeWaitingThreads(deps: ReplyJudgeDeps, accountId: string): Promise<number> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const candidates = await waitingCandidates(db, {
    accountIds: [accountId],
    cutoff: new Date(now.getTime() - CUTOFF_MS),
    unjudgedBelowAttempts: REPLY_JUDGMENT_MAX_ATTEMPTS,
    limit: deps.maxPerTick ?? REPLY_JUDGMENT_MAX_PER_TICK,
  });
  if (candidates.length === 0) return 0;
  const ctx = await replyContext(db, accountId);
  if (!ctx) return 0;
  // Il tetto giornaliero della casella, insieme alla classificazione: quanti
  // run restano oggi (i run di questo giro li conta `left`, perché un runner
  // che non registra consumi non li farebbe vedere alla query).
  const maxPerDay = deps.maxPerDay ?? DEFAULT_GMAIL_MAX_PER_DAY;
  let left = maxPerDay > 0 ? maxPerDay - (await countClassifyRunsSince(db, accountId, 24)) : Number.POSITIVE_INFINITY;
  let written = 0;
  for (const c of candidates) {
    if (left <= 0) break;
    // Il budget a OGNI run: esaurito a metà giro, il giro si ferma.
    if ((await aiBudgetState(db, deps.monthlyCostUsdFn ?? monthlyCostUsd)).exhausted) break;
    // Il tentativo si consuma PRIMA del run (guardato sull'ultimo messaggio ancora senza giudizio).
    const claimed = await db
      .update(emailMessages)
      .set({ replyJudgmentAttempts: sql`${emailMessages.replyJudgmentAttempts} + 1` })
      // Anche sotto il tetto (rimandi, lotto 4): un giro sovrapposto può aver
      // consumato l'ultimo tentativo dopo la lettura dei candidati.
      .where(
        and(
          eq(emailMessages.id, c.lastMessageId),
          sql`${emailMessages.replyJudgment} is null`,
          sql`${emailMessages.replyJudgmentAttempts} < ${REPLY_JUDGMENT_MAX_ATTEMPTS}`,
        ),
      )
      .returning({ attempts: emailMessages.replyJudgmentAttempts });
    if (claimed.length === 0) continue;
    const thread = (
      await db
        .select({ from: emailMessages.fromAddress, at: emailMessages.receivedAt, text: emailMessages.textExcerpt })
        .from(emailMessages)
        .where(and(eq(emailMessages.accountId, accountId), eq(emailMessages.threadId, c.threadId)))
        .orderBy(desc(emailMessages.receivedAt), desc(emailMessages.id))
        .limit(THREAD_MESSAGES)
    ).reverse();
    const prompt = buildReplyJudgmentPrompt({
      ...ctx,
      language: deps.lang ?? "it",
      messages: thread.map((m) => ({ from: m.from, at: m.at, text: (m.text ?? "").slice(0, MESSAGE_CHARS) })),
    });
    const cwd = await mkdtemp(join(tmpdir(), "stubwise-reply-judgment-"));
    let stored: Record<string, unknown> | null = null;
    let limited = false;
    try {
      const run = await runWithProviders(
        deps.select,
        { projectId: c.projectId, workClass: "background" },
        (provider) =>
          deps.runner.run({
            usage: { operation: "mail_reply_judgment", projectId: c.projectId, emailMessageId: c.lastMessageId },
            cwd,
            prompt,
            ...(deps.model !== undefined ? { model: deps.model } : {}),
            ...(provider !== undefined ? { provider } : {}),
            builtinTools: NATIVE_TOOLS.text,
            permissionMode: "default",
            maxTurns: 2,
            timeoutMs: 120_000,
          }),
        limitTextOfRun,
      );
      left -= 1;
      // Un limite del provider non è colpa del messaggio: il tentativo si
      // restituisce e il giro si ferma (come il `deferred` della
      // classificazione). Altrimenti due tick al limite lasciavano un `error`
      // permanente su ogni candidato.
      limited = run.kind === "legacy_limited" || (run.kind === "unavailable" && isQuotaWait(run.reason));
      if (run.kind === "done") {
        const value = "value" in run ? run.value : undefined;
        const parsed = value ? parseAgentJson(replyJudgmentOutputSchema, textFromRun(value) ?? "") : null;
        // Il modello USATO (risolto per operazione dal TrackingAgentRunner), col
        // ripiego su quello passato a mano (rimandi, lotto 4).
        const model = (value && "model" in value ? value.model : undefined) ?? deps.model;
        if (parsed) stored = { needsMyReply: parsed.needsMyReply, reason: parsed.reason, ...(model ? { model } : {}), at: now.toISOString() };
      }
    } catch (error) {
      deps.log?.(`google: giudizio sulla risposta del thread ${c.threadId} fallito: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    if (limited) {
      await db
        .update(emailMessages)
        .set({ replyJudgmentAttempts: sql`greatest(${emailMessages.replyJudgmentAttempts} - 1, 0)` })
        .where(and(eq(emailMessages.id, c.lastMessageId), sql`${emailMessages.replyJudgment} is null`));
      deps.log?.(`google: giudizio sulla risposta rimandato (provider al limite), riprendo al prossimo giro`);
      break;
    }
    if (stored === null && claimed[0]!.attempts >= REPLY_JUDGMENT_MAX_ATTEMPTS) stored = { error: "invalid_or_failed", at: now.toISOString() };
    if (stored !== null) {
      await db.update(emailMessages).set({ replyJudgment: stored as never }).where(and(eq(emailMessages.id, c.lastMessageId), sql`${emailMessages.replyJudgment} is null`));
      if (!("error" in stored)) written += 1;
    }
  }
  return written;
}

