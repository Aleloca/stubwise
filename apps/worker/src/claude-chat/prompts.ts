import type { ClaudeConversationContext, Language } from "@stubwise/shared";

/**
 * Prompt della conversazione libera con Claude (chat, fetta 1). Il PRIMO turno
 * (o una ripartenza senza `--resume`) riceve il CONTRATTO e il contesto; i
 * turni ripresi solo il messaggio, perché la conversazione CLI ha già il resto.
 * Il CLI non ha un system prompt separato nel nostro runner: il contratto è la
 * testa del primo prompt.
 *
 * INJECTION: messaggi, titoli e testi letti con i tool sono input non fidato.
 * Il caso peggiore è che Claude legga ciò che chi scrive può già leggere: i
 * tool sono solo GET con la visibilità dell'autore, e non esiste un tool che
 * scrive. Nessun segreto entra mai qui (il token del turno resta nel ponte).
 */
export interface ChatPromptContext {
  language: Language;
  authorName: string;
  /** Il contesto della pagina da cui nasce la conversazione, se c'è. */
  context: ClaudeConversationContext | null;
  /** Il server MCP dei tool è disponibile in questo turno. */
  toolsAvailable: boolean;
  recentTranscript: { role: "user" | "agent"; text: string }[];
}

const LANGUAGE_NAME: Record<Language, string> = { en: "English", it: "Italian" };

export const CHAT_CONTRACT = [
  "HOW THIS CONVERSATION WORKS",
  "- This is a PRIVATE conversation with one person. You read Stubwise ON THEIR BEHALF: the stubwise_chat tools see exactly what this person can see, nothing more.",
  "- You can only READ: list projects, search and read tasks, read requests, search a project's docs, read a project's weekly brief and decision log. Use them to ground every answer in real data, and cite codes (e.g. AUD-12) and page titles you actually read.",
  "- You do NOT do anything. You cannot create, edit, plan, assign, comment, approve, merge, start runs, send messages or change settings, and you must not pretend you did. When asked to DO something, say clearly that you cannot do it from this conversation yet, and point to where it is done by hand in Stubwise (the task page, the requests list, the project overview, the settings).",
  "- If a tool says something is not found or not visible, say it is not available to this person: never guess its content, never say whether it exists.",
  "- There are no files, shell or web here: only the stubwise_chat tools. Never ask for passwords, tokens or other secrets.",
  "- Weekly briefs are generated text: cite them as such. The decision log records facts written by people.",
].join("\n");

const block = (label: string, body: string) => `--- ${label} ---\n${body}`;

export function buildChatPrimingPrompt(ctx: ChatPromptContext, openingText: string): string {
  const parts = [
    `You are Claude, the assistant inside Stubwise, talking with ${ctx.authorName}.`,
    "",
    `Always answer in ${LANGUAGE_NAME[ctx.language]}, in short Markdown prose, unless the person writes in another language.`,
    "",
    CHAT_CONTRACT,
    "",
  ];
  if (!ctx.toolsAvailable) {
    parts.push("The Stubwise tools are unavailable in this turn: say so if the answer needs data.", "");
  }
  if (ctx.context !== null) {
    parts.push(
      block("PAGE THE PERSON IS LOOKING AT", `${ctx.context.kind}: ${ctx.context.id} (read it with the tools if it matters)`),
      "",
    );
  }
  if (ctx.recentTranscript.length > 0) {
    parts.push(
      block(
        "CONVERSATION SO FAR (latest messages)",
        ctx.recentTranscript.map((m) => `[${m.role === "user" ? "person" : "you"}] ${m.text}`).join("\n\n"),
      ),
      "",
    );
  }
  parts.push(block("MESSAGE", openingText));
  return parts.join("\n");
}

/**
 * Turno ripreso con `--resume`: la conversazione CLI ha già il contratto, ma
 * il contesto della pagina può essere cambiato (chi scrive ha aperto un'altra
 * task): si ripete, come `tipo: id`, solo quando c'è.
 */
export function buildChatResumePrompt(openingText: string, context: ClaudeConversationContext | null = null): string {
  if (context === null) return openingText;
  return [
    block("PAGE THE PERSON IS LOOKING AT", `${context.kind}: ${context.id} (read it with the tools if it matters)`),
    "",
    block("MESSAGE", openingText),
  ].join("\n");
}
