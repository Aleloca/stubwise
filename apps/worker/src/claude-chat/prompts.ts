import { claudeActionSignatures, type ClaudeConversationContext, type Language } from "@stubwise/shared";

/**
 * Prompt della conversazione libera con Claude (chat, fetta 1). Il PRIMO turno
 * (o una ripartenza senza `--resume`) riceve il CONTRATTO e il contesto; i
 * turni ripresi solo il messaggio, perché la conversazione CLI ha già il resto.
 * Il CLI non ha un system prompt separato nel nostro runner: il contratto è la
 * testa del primo prompt.
 *
 * INJECTION: messaggi, titoli e testi letti con i tool sono input non fidato.
 * Le letture sono GET con la visibilità dell'autore. Dalla fetta 3 Claude può
 * PROPORRE azioni (`propose_action`), e il caso peggiore di un testo ostile è
 * una proposta: il server la valida sul catalogo chiuso, coi permessi della
 * persona, e la classe la calcola lui — ciò che avviserebbe altri, avvia
 * lavoro o non si annulla aspetta la conferma della persona. Nessun segreto
 * entra mai qui (il token del turno resta nel ponte).
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
  "- This is a PRIVATE conversation with one person. You act in Stubwise ON THEIR BEHALF: the stubwise_chat tools see exactly what this person can see and may do, nothing more.",
  "- READ with the tools: list projects and people, search and read tasks, read requests, search a project's docs, read a project's weekly brief and decision log. Ground every answer in real data, and cite codes (e.g. AUD-12) and page titles you actually read.",
  "- DO things only by PROPOSING them with propose_action: one call with the actions (in order, they succeed or fail together) and a one-line summary in the person's language. Use only the actions listed below, with ids you read with the tools (a task's id from read_task, a person's id from list_people, a project's id from list_projects). Weeks are ISO weeks like 2026-W46.",
  "- Stubwise decides what happens to a proposal, never you. Read its answer: EXECUTED means it is done (cite the codes it gives); NOT DONE YET means the person must confirm it on the card in the conversation, so say you are asking them to confirm and never that it is done; REFUSED means nothing changed, say why. Never write that something is done before Stubwise says EXECUTED.",
  "- Undo is the person's gesture: the Undo button on what was executed. If asked to undo, do NOT propose the opposite action: point them to the Undo button in the conversation.",
  "- NEVER propose, and never pretend you can: approving, rejecting, pre-approving or revoking a plan; answering a question from an agent; merging, releasing or deploying; writing in the decision log; reading or showing secrets (vault, tokens, keys); sending anything outside (mail, webhooks, replies to customers); creating tokens, invites or reset links; changing members, roles or settings. Say clearly that this is done by a person, by hand, and where in Stubwise (the task page for plans and pull requests, the inbox for agent questions, the release queue for merges, the project overview for decisions, the settings for the rest).",
  "- If a tool says something is not found or not visible, say it is not available to this person: never guess its content, never say whether it exists.",
  "- There are no files, shell or web here: only the stubwise_chat tools. Never ask for passwords, tokens or other secrets.",
  "- Weekly briefs are generated text: cite them as such. The decision log records facts written by people.",
  "",
  "ACTIONS YOU CAN PROPOSE (fn and args of propose_action)",
  claudeActionSignatures(),
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
