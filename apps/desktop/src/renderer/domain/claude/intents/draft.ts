import type { ContextRef, FieldRef } from "../../../data/types";
import { labelled, resulted, type Answer, type ReadAction } from "../answers";
import type { IntentContext } from "../context";
import { findCodes, isHowToQuestion, normalize, stripCourtesy } from "../parse";

// Le bozze (area 10b, Task 8: S6, S6b, Posta, descrizione — D1). «Scrivi la
// risposta», «draft the release notes», «scrivi un'email a … per dire che
// …», «write the description for ACQ-14»: Claude scrive un testo per uno dei
// quattro campi (risposta di supporto, note di rilascio, corpo dell'email,
// descrizione di una task) e non scrive MAI dati. Il testo diventa un evento
// `draft` che il riquadro mette nel campo della pagina (Task 10); inviare e
// salvare restano gesti della persona — «scrivi e manda l'email» scrive la
// bozza e poi la riga D `send`, nessun invio. Il campo lo dicono il
// contesto del riquadro (`ctx.context`, solo se chi chiede lo vede) o un
// codice nella frase; chi può cosa lo dice il livello dati (le letture
// `*Draft`), il motore non lo deduce. Il messaggio della Chat resta escluso.

const K = "claude.answers.draft";

/** Il verbo di scrittura in testa (imperativo) — e solo lui fa una bozza. */
const WRITE =
  /^(write|draft|prepare|scrivi|scrivimi|scrivila|scrivilo|prepara|preparami|preparala)\b/;
/** Lo stesso all'infinito, dopo una cortesia («Puoi scrivere la risposta?»). */
const WRITE_INF = /^(write|draft|prepare|scrivere|scrivermi|scriverla|preparare|prepararmi)\b/;
/** Il campo nominato: risposta, note, email, descrizione, una bozza qualunque, un messaggio. */
const FIELD_WORD =
  /\b(repl(y|ies)|risposta|release notes|note di rilascio|e-?mails?|mail|descriptions?|descrizione|drafts?|bozza|messages?|messaggio)\b/;
/** Il registro decisioni è delle persone (`refused`): «scrivi la decisione» non è una bozza. */
const DECISION = /\b(decisions?|decisione|decisioni)\b/;

const NOTES = /\b(release notes|note di rilascio)\b/;
const DESCRIPTION = /\b(descriptions?|descrizione)\b/;
const CHAT = /\b(messages?|messaggio|messaggi|channels?|canale|canali)\b/;
const EMAIL = /\b(e-?mails?|mail)\b/;
const REPLY = /\b(repl(y|ies)|risposta)\b/;
/** «… e manda», «and send»: la bozza, poi la riga D `send` (D1). */
const AND_SEND = /\b(and|e|ed)\s+(send|manda|mandala|mandalo|invia|inviala|invialo|spedisci)\b/;
/** L'indicazione di un'email: ciò che segue «per dire che» / «saying». */
const HINT =
  /\b(?:per dir(?:e|gli|le)(?: loro)?(?: che)?|dicendo(?: che)?|che dica(?: che)?|saying(?: that)?|to say(?: that)?|telling (?:them|him|her)(?: that)?)\s+(.+)$/i;
/** Un codice di conversazione di supporto (`ACQ-S2`). */
const SUPPORT_CODE = /\b([a-z]{2,4})-s(\d+)\b/i;

/**
 * Il comando chiede una bozza: un verbo di scrittura in testa (dopo saluti e
 * cortesie) e un campo. Una domanda «come si fa» resta a `howto` (il
 * controllo unico, ruling T6 I1); «scrivi la decisione» resta una riga D.
 * Un codice di task nella frase non la esclude: dice il campo («scrivi la
 * descrizione di ACQ-14»), al contrario di archivio e membri.
 */
export function isDraftRequest(text: string): boolean {
  if (isHowToQuestion(text)) return false;
  // Il verbo in testa basta a farne un comando: «who wrote…?» non comincia così.
  const { polite, command } = stripCourtesy(normalize(text));
  if (!WRITE.test(command) && !(polite && WRITE_INF.test(command))) return false;
  return FIELD_WORD.test(command) && !DECISION.test(command);
}

/** Che campo chiede la frase; `any` = una bozza qualunque, lo dice il contesto. */
type Want = "notes" | "description" | "chat" | "email" | "reply" | "any";

function wantOf(plain: string): Want {
  if (NOTES.test(plain)) return "notes";
  if (DESCRIPTION.test(plain)) return "description";
  if (EMAIL.test(plain)) return "email";
  if (CHAT.test(plain)) return "chat";
  if (REPLY.test(plain)) return "reply";
  return "any";
}

const say = (text: string, actions: ReadAction[] = []): Answer => ({ actions, text });
const who = (ctx: IntentContext, action: string, code: string) =>
  `[${ctx.t("claude.answers.refused.who")}](who:${action}/${code})`;
const projectCodeOf = (code: string) => code.split("-")[0]!;

/** «Non trovo X»: identica per un codice invisibile, inesistente o eliminato (R-G5). */
function notFound(ctx: IntentContext, code: string, lookup: ReadAction): Answer {
  return say(ctx.t("claude.answers.explain.notFound", { code }), [
    { ...lookup, ...resulted(ctx.t, "claude.answers.actions.notFound") },
  ]);
}

/** La frase di quando nessun campo è aperto; con un codice visibile, il suo link. */
async function nowhere(text: string, ctx: IntentContext): Promise<Answer> {
  const sentence = ctx.t(`${K}.openField`);
  const support = SUPPORT_CODE.exec(text);
  if (support) {
    const code = `${support[1]!.toUpperCase()}-S${support[2]}`;
    const id = await ctx.read.supportConversationIdOf(code);
    if (!id) return notFound(ctx, code, lookupOf(ctx, code));
    return {
      ...say(sentence),
      place: {
        route: `#/p/${projectCodeOf(code)}/support/${code}`,
        labelKey: `${K}.openCode`,
        labelParams: { code },
      },
    };
  }
  const task = findCodes(text).find((c) => c.kind === "task");
  if (task) {
    const found = await ctx.read.getTaskByCode(task.code);
    if (!found) return notFound(ctx, task.code, lookupOf(ctx, task.code));
    return {
      ...say(sentence),
      place: {
        route: `#/p/${task.projectCode}/tasks?task=${task.code}`,
        labelKey: `${K}.openCode`,
        labelParams: { code: task.code },
      },
    };
  }
  return say(sentence);
}

const lookupOf = (ctx: IntentContext, code: string): ReadAction => ({
  tool: "get_ticket",
  ...labelled(ctx.t, "claude.answers.actions.lookup", { code }),
});

/** Il campo e la riga D `send`, se la frase chiede anche di inviare (D1). */
function withSend(
  answer: Answer,
  sends: boolean,
  ctx: IntentContext,
  route: string,
  labelKey: string,
): Answer {
  if (!sends) return answer;
  return {
    ...answer,
    text: ctx.t("claude.answers.refused.send"),
    place: { route, labelKey: `${K}.${labelKey}` },
  };
}

export async function draft(text: string, ctx: IntentContext): Promise<Answer> {
  const { t } = ctx;
  const plain = normalize(text);
  const want = wantOf(plain);
  // Il messaggio della Chat resta escluso (D1): lì la scrive @Claude nel thread.
  if (want === "chat") return say(t(`${K}.chat`));
  // Nella Chat (senza `classify`) nessuno metterebbe la bozza in un campo (P11).
  if (!ctx.classify) return say(t(`${K}.inPanel`));
  const sends = AND_SEND.test(plain);
  const context = ctx.context ?? null;

  // Un codice nella frase vale come il contesto: la conversazione, la task.
  const support = SUPPORT_CODE.exec(text);
  const taskRef = findCodes(text).find((c) => c.kind === "task");

  if (want === "notes" || (want === "any" && context?.kind === "pr")) {
    const seen = context?.kind === "pr" ? await ctx.read.describeContext(context) : null;
    return context?.kind === "pr" && seen?.code
      ? releaseNotes(context.prId, seen.code, ctx)
      : nowhere(text, ctx);
  }
  if (want === "description" || (want === "any" && !support && taskRef)) {
    if (taskRef) {
      const lookup = lookupOf(ctx, taskRef.code);
      const task = await ctx.read.getTaskByCode(taskRef.code);
      if (!task) return notFound(ctx, taskRef.code, lookup);
      return description(task.id, taskRef.code, ctx, [lookup]);
    }
    if (context?.kind === "task") {
      const seen = await ctx.read.describeContext(context);
      if (seen?.code) return description(context.taskId, seen.code, ctx);
    }
    return nowhere(text, ctx);
  }
  if (want === "email") {
    return context?.kind === "mail" ? mail(context, text, sends, ctx) : nowhere(text, ctx);
  }
  // Una risposta (o una bozza qualunque): la conversazione col codice, poi il contesto.
  if (support) {
    const code = `${support[1]!.toUpperCase()}-S${support[2]}`;
    const id = await ctx.read.supportConversationIdOf(code);
    if (!id) return notFound(ctx, code, lookupOf(ctx, code));
    return supportReply(id, code, sends, ctx);
  }
  if (context?.kind === "support") {
    const seen = await ctx.read.describeContext(context);
    if (seen?.code) return supportReply(context.conversationId, seen.code, sends, ctx);
  }
  if (context?.kind === "mail") return mail(context, text, sends, ctx);
  if (want === "any" && context?.kind === "task") {
    const seen = await ctx.read.describeContext(context);
    if (seen?.code) return description(context.taskId, seen.code, ctx);
  }
  return nowhere(text, ctx);
}

/** S6: la risposta di supporto, o la riga col «Who?» senza `support.reply`. */
async function supportReply(
  conversationId: string,
  code: string,
  sends: boolean,
  ctx: IntentContext,
): Promise<Answer> {
  const body = await ctx.read.supportReplyDraft(conversationId);
  if (body === null) {
    return say(`${ctx.t(`${K}.cantReply`)} ${who(ctx, "replyCustomers", projectCodeOf(code))}`);
  }
  const field: FieldRef = { kind: "supportReply", conversationId };
  return withSend(
    { ...say(""), draft: { field, text: body } },
    sends,
    ctx,
    `#/p/${projectCodeOf(code)}/support/${code}`,
    "openReply",
  );
}

/** S6b: le note di rilascio della PR aperta. */
async function releaseNotes(
  prId: string,
  projectCode: string,
  ctx: IntentContext,
): Promise<Answer> {
  const notes = await ctx.read.releaseNotesDraft(prId);
  if (notes === null) {
    return say(`${ctx.t(`${K}.cantEditNotes`)} ${who(ctx, "release", projectCode)}`);
  }
  if (notes.text === "") return say(ctx.t(`${K}.noNotes`));
  return {
    ...say(""),
    draft: { field: { kind: "releaseNotes", prId }, text: notes.text, sources: notes.sources },
  };
}

/** D1: il corpo dell'email aperta — una risposta, o l'email nuova con l'indicazione. */
async function mail(
  context: Extract<ContextRef, { kind: "mail" }>,
  text: string,
  sends: boolean,
  ctx: IntentContext,
): Promise<Answer> {
  const hint = HINT.exec(text)?.[1]?.trim() ?? "";
  const result = await ctx.read.mailDraft(context.threadId, hint);
  if (!result.ok) {
    return result.reason === "hint" ? say(ctx.t(`${K}.askHint`)) : nowhere(text, ctx);
  }
  const field: FieldRef = { kind: "mailBody", threadId: context.threadId };
  return withSend(
    {
      ...say(""),
      draft: {
        field,
        text: result.text,
        ...(result.used.length > 0 ? { sources: result.used } : {}),
      },
    },
    sends,
    ctx,
    context.threadId === null ? "#/mail?compose=new" : `#/mail/${context.threadId}`,
    context.threadId === null ? "openEmail" : "openReply",
  );
}

/** D1: la descrizione di una task, dalle sue fonti; mai `updateTask`. */
async function description(
  taskId: string,
  code: string,
  ctx: IntentContext,
  actions: ReadAction[] = [],
): Promise<Answer> {
  const result = await ctx.read.taskDescriptionDraft(taskId);
  if (result.ok) {
    return {
      ...say("", actions),
      draft: {
        field: { kind: "taskDescription", taskId },
        text: result.text,
        sources: result.sources,
      },
    };
  }
  switch (result.reason) {
    case "not_found":
      return notFound(ctx, code, lookupOf(ctx, code));
    case "forbidden":
      return say(
        `${ctx.t(`${K}.cantEditTask`, { code })} ${who(ctx, "editTasks", projectCodeOf(code))}`,
        actions,
      );
    case "no_source":
      return say(ctx.t(`${K}.noSource`, { code }), actions);
  }
}
