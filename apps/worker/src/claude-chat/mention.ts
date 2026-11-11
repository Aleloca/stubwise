import { agentSessionEvents, agentSessionInputs, chatClaudeQuestions, chatMessages, type Db } from "@stubwise/db";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

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
    // Fuori dal testo pubblico (review della fetta 3): gli errori del CLI
    // (`apiError`, un limite o un errore dell'API incartato come messaggio
    // dell'assistente) e il testo di un tentativo scartato (`discarded`).
    .filter((e) => {
      const data = e.data as { apiError?: unknown; discarded?: unknown };
      return data.apiError !== true && data.discarded !== true;
    })
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
 * fallito. Un budget finito a metà è `budget`. Review della fetta 3:
 * - con un input ancora in coda (una risposta alla domanda arrivata prima della
 *   fine del turno) la risposta resta «working»: la chiude il turno dopo;
 * - un «done» il cui ultimo testo è un errore del CLI è un «failed». Il motivo
 *   resta `other`: `chat_messages` non ha un valore per «limite» o «errore
 *   dell'API», e il testo dell'errore non esce.
 */
export async function finishReply(db: Db, sessionId: string, outcome: "done" | "failed" | "budget"): Promise<void> {
  let effective = outcome;
  if (outcome === "done") {
    const [last] = await db
      .select({ data: agentSessionEvents.data })
      .from(agentSessionEvents)
      .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "assistant_text")))
      .orderBy(desc(agentSessionEvents.id))
      .limit(1);
    if ((last?.data as { apiError?: unknown } | undefined)?.apiError === true) effective = "failed";
  }
  const set =
    effective === "done"
      ? { claudeState: "done" as const }
      : { claudeState: "failed" as const, claudeError: effective === "budget" ? ("budget" as const) : ("other" as const) };
  const [row] = await db
    .update(chatMessages)
    .set({ ...set, updatedAt: sql`now()` })
    .where(
      and(
        eq(chatMessages.agentSessionId, sessionId),
        eq(chatMessages.claudeState, "working"),
        sql`not exists (
          select 1 from ${agentSessionInputs} i
          where i.session_id = ${sessionId} and i.status = 'pending' and i.text <> ''
        )`,
      ),
    )
    .returning({ channelId: chatMessages.channelId });
  if (row) await notify(db, row.channelId);
}

/**
 * All'avvio del worker (review della fetta 3): nessun turno è vivo, quindi una
 * risposta «working» senza un input in coda non la chiuderà nessuno. Diventa
 * «failed» (`other`); quelle con un input in coda le riprende il relay, quelle
 * «waiting» aspettano chi ha chiamato.
 */
export async function closeOrphanReplies(db: Db): Promise<number> {
  const rows = await db
    .update(chatMessages)
    .set({ claudeState: "failed", claudeError: "other", updatedAt: sql`now()` })
    .where(
      and(
        eq(chatMessages.kind, "claude"),
        eq(chatMessages.claudeState, "working"),
        sql`not exists (
          select 1 from ${agentSessionInputs} i
          where i.session_id = ${chatMessages.agentSessionId} and i.status = 'pending' and i.text <> ''
        )`,
      ),
    )
    .returning({ channelId: chatMessages.channelId });
  for (const channelId of new Set(rows.map((r) => r.channelId))) await notify(db, channelId);
  return rows.length;
}

/** L'ultimo evento della sessione: il segno da cui parte un tentativo. */
export async function lastEventId(db: Db, sessionId: string): Promise<bigint> {
  const [row] = await db
    .select({ id: agentSessionEvents.id })
    .from(agentSessionEvents)
    .where(eq(agentSessionEvents.sessionId, sessionId))
    .orderBy(desc(agentSessionEvents.id))
    .limit(1);
  return row?.id ?? 0n;
}

/**
 * Un tentativo scartato (un `--resume` rifiutato, un account al limite): il
 * testo che ha scritto dopo `afterId` resta nella trascrizione di chi chiama,
 * ma non nella risposta, così il tentativo dopo non lo ripete (review della
 * fetta 3).
 */
export async function discardAttemptText(db: Db, sessionId: string, afterId: bigint): Promise<void> {
  await db
    .update(agentSessionEvents)
    .set({ data: sql`${agentSessionEvents.data} || '{"discarded": true}'::jsonb` })
    .where(and(eq(agentSessionEvents.sessionId, sessionId), eq(agentSessionEvents.type, "assistant_text"), gt(agentSessionEvents.id, afterId)));
}

/** Il primo input della sessione: la chiamata, col contesto del thread. */
export async function callInputText(db: Db, sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ text: agentSessionInputs.text })
    .from(agentSessionInputs)
    .where(eq(agentSessionInputs.sessionId, sessionId))
    .orderBy(asc(agentSessionInputs.createdAt), asc(agentSessionInputs.id))
    .limit(1);
  return row?.text ?? null;
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
