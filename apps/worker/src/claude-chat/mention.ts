import { agentSessionEvents, chatClaudeQuestions, chatMessages, type Db } from "@stubwise/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

/**
 * @Claude nella Chat, lato worker (area 4, fetta 3; piano
 * `docs/plans/2026-11-10-integrazione-area4-fetta3-plan.md`). La risposta è un
 * messaggio della Chat (`kind claude`) legato alla sessione `chat_mention`
 * della chiamata: qui il worker ci scrive il TESTO dell'assistente (dal vivo e
 * alla fine), lo STATO a fine turno e la DOMANDA di `ask_question`. Il canale
 * Postgres dello stream della Chat è `chat_channel` (`CHAT_CHANNEL_NOTIFY` del
 * server): ogni scrittura porta avanti `updated_at` e lo sveglia.
 */

const CHAT_CHANNEL_NOTIFY = "chat_channel";

/** Il testo per la ricerca, come `foldChatText` del server. */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

async function notify(db: Db, channelId: string): Promise<void> {
  await db.execute(sql`select pg_notify(${CHAT_CHANNEL_NOTIFY}, ${JSON.stringify({ channelId })})`);
}

/** La risposta di Claude di una sessione (una per chiamata). */
export async function replyOf(db: Db, sessionId: string): Promise<typeof chatMessages.$inferSelect | null> {
  const [row] = await db.select().from(chatMessages).where(eq(chatMessages.agentSessionId, sessionId));
  return row ?? null;
}

/**
 * Il testo della risposta = i testi dell'assistente della sessione, in ordine
 * (il turno della chiamata e quello della ripresa dopo la domanda: è la STESSA
 * risposta). Si scrive solo se è cambiato, su una risposta non eliminata.
 */
export async function syncReplyText(db: Db, sessionId: string): Promise<void> {
  const events = await db
    .select({ data: agentSessionEvents.data })
    .from(agentSessionEvents)
    .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "assistant_text")))
    .orderBy(asc(agentSessionEvents.id));
  const text = events
    .map((e) => (e.data as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .join("\n\n")
    .trim();
  const [row] = await db
    .update(chatMessages)
    .set({ body: text, searchFolded: fold(text), updatedAt: sql`now()` })
    .where(
      and(
        eq(chatMessages.agentSessionId, sessionId),
        isNull(chatMessages.deletedAt),
        sql`${chatMessages.body} is distinct from ${text}`,
      ),
    )
    .returning({ channelId: chatMessages.channelId });
  if (row) await notify(db, row.channelId);
}

/**
 * A fine turno: «done» se lavorava (una domanda l'ha già messa in «waiting»,
 * uno stop in «stopped»: non si toccano), «failed» col motivo se il turno è
 * fallito. Un budget finito a metà è `budget`.
 */
export async function finishReply(db: Db, sessionId: string, outcome: "done" | "failed" | "budget"): Promise<void> {
  const set =
    outcome === "done"
      ? { claudeState: "done" as const }
      : { claudeState: "failed" as const, claudeError: outcome === "budget" ? ("budget" as const) : ("other" as const) };
  const [row] = await db
    .update(chatMessages)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(chatMessages.agentSessionId, sessionId), eq(chatMessages.claudeState, "working")))
    .returning({ channelId: chatMessages.channelId });
  if (row) await notify(db, row.channelId);
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max ? v.trim() : null;

/**
 * `ask_question` (R-G4): UNA domanda a scelta a chi ha chiamato, mentre la
 * risposta lavora. Si scrive la domanda e la risposta va in «waiting»; poi il
 * modello chiude il turno. Una seconda domanda nella stessa risposta è
 * rifiutata (indice unico). Testo e opzioni si validano qui.
 */
export async function askChatQuestion(db: Db, sessionId: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  const question = str(args["question"], 500);
  const rawOptions = Array.isArray(args["options"]) ? args["options"] : [];
  const options = rawOptions.flatMap((o) => {
    const label = str((o as { label?: unknown } | null)?.label, 120);
    const description = str((o as { description?: unknown } | null)?.description, 300);
    return label ? [{ label, ...(description ? { description } : {}) }] : [];
  });
  if (!question || options.length < 2 || options.length > 5 || options.length !== rawOptions.length) {
    return { ok: false, text: "Invalid question: write a short question and 2 to 5 options, each with a label." };
  }
  const reply = await replyOf(db, sessionId);
  if (!reply || reply.deletedAt !== null || reply.claudeState !== "working") {
    return { ok: false, text: "You cannot ask now: the answer was stopped or is no longer running." };
  }
  const inserted = await db
    .insert(chatClaudeQuestions)
    .values({ replyMessageId: reply.id, text: question, options })
    .onConflictDoNothing()
    .returning({ id: chatClaudeQuestions.id });
  if (inserted.length === 0) {
    return { ok: false, text: "You already asked your one question in this answer: say what is still unclear in words." };
  }
  await db
    .update(chatMessages)
    .set({ claudeState: "waiting", updatedAt: sql`now()` })
    .where(and(eq(chatMessages.id, reply.id), inArray(chatMessages.claudeState, ["working"])));
  await notify(db, reply.channelId);
  return {
    ok: true,
    text: "The question is in the thread for the person who called you. End your turn now, with nothing else: when they answer, you will continue.",
  };
}
