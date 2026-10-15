import type { Language } from "@stubwise/shared";

/**
 * Prompt della sessione di refinement (design 2026-10-14 §4.1). Il PRIMO
 * turno (o una ripartenza senza `--resume`) riceve il contesto completo; i
 * turni ripresi con `--resume` solo il messaggio della persona, perché la
 * conversazione CLI ha già tutto il resto.
 *
 * INJECTION: titolo, documento, piano, decisioni e messaggi sono input non
 * fidato. Il caso peggiore è che l'agente legga il codice (che legge già) o
 * scriva sulla voce con i tool (che passano dal ponte, con revisione).
 */
export interface RefinePromptContext {
  language: Language;
  item: {
    title: string;
    document: string;
    implementationPlan: string | null;
    originContent: string | null;
    effort: number | null;
    risk: string | null;
    riskNote: string | null;
    urgency: string | null;
  };
  repos: { name: string; dir: string }[];
  /** Blocco del grafo già pronto (`renderGraphHint(..., "it")`), "" senza grafi. */
  graphHint: string;
  decisions: { title: string; decision: string; decidedAt: Date }[];
  recentTranscript: { role: "user" | "agent"; text: string }[];
}

const LANGUAGE_NAME: Record<Language, string> = { en: "English", it: "Italian" };

const MANDATE = [
  "COME LAVORI IN QUESTA SESSIONE",
  "- È una conversazione con le persone del team: rispondi a chi ti scrive. Leggi il codice (Read/Grep/Glob) per fondare le risposte sui fatti; non modificare file e non eseguire comandi.",
  "- Se ti serve una scelta o un'informazione, CHIEDILA SCRIVENDO NELLA RISPOSTA: qui la chat è il canale verso le persone, non esiste ask_user.",
  "- Design e piano NON sono file del repository: quando sono maturi salvali con i tool `set_design` e `set_plan` (sostituiscono il testo attuale; Stubwise conserva la versione precedente), e titolo, effort (1–5), rischio con la sua nota e urgenza con `update_item`. Dopo ogni salvataggio dillo in chat. Se un tool risponde con un errore, correggi e riprova.",
  "- Non chiudere il lavoro da solo: ogni turno finisce con una risposta a chi ha scritto, e la persona decide quando un documento è pronto.",
].join("\n");

const block = (label: string, body: string) => `--- ${label} ---\n${body}`;

export function buildRefinePrimingPrompt(ctx: RefinePromptContext, openingText: string): string {
  const { item } = ctx;
  const meta = [
    `- effort: ${item.effort ?? "non stimato"} (scala 1–5)`,
    `- rischio: ${item.risk ?? "non stimato"}${item.riskNote ? ` — ${item.riskNote}` : ""}`,
    `- urgenza: ${item.urgency ?? "non stimata"}`,
  ].join("\n");
  const repos = ctx.repos.map((r) => `- ${r.name}: ${r.dir}`).join("\n");
  const parts = [
    "Sei un ingegnere senior che affianca il team nel raffinamento di una voce del backlog di prodotto, in una sessione di Claude Code. La tua working directory contiene, in SOLA LETTURA, tutte le repository del progetto." +
      (ctx.graphHint ? `\n\n${ctx.graphHint}` : ""),
    "",
    `Rispondi SEMPRE in ${LANGUAGE_NAME[ctx.language]}, in prosa Markdown. Cita percorsi e simboli reali che hai visto. Se una risposta non è nel codice, dillo invece di inventare.`,
    "",
    MANDATE,
    "",
    block("REPOSITORY APERTE", repos || "(nessuna)"),
    "",
    block("VOCE: TITOLO", item.title),
    "",
    block("VOCE: METADATI", meta),
    "",
  ];
  if (item.originContent !== null) parts.push(block("VOCE: RICHIESTA ORIGINALE", item.originContent), "");
  parts.push(block(item.originContent !== null ? "VOCE: DESIGN ATTUALE" : "VOCE: DOCUMENTO", item.document || "(vuoto)"), "");
  parts.push(block("VOCE: PIANO ATTUALE", item.implementationPlan ?? "(nessun piano)"), "");
  if (ctx.decisions.length > 0) {
    parts.push(
      block(
        "DECISIONI RECENTI DEL PROGETTO (fatti: non riproporre alternative già scartate)",
        ctx.decisions.map((d) => `- ${d.decidedAt.toISOString().slice(0, 10)} · ${d.title}: ${d.decision}`).join("\n"),
      ),
      "",
    );
  }
  if (ctx.recentTranscript.length > 0) {
    parts.push(
      block(
        "CONVERSAZIONE FINORA (ultimi messaggi)",
        ctx.recentTranscript.map((m) => `[${m.role === "user" ? "persona" : "tu"}] ${m.text}`).join("\n\n"),
      ),
      "",
    );
  }
  parts.push(block("MESSAGGIO", openingText));
  return parts.join("\n");
}

/** Turno ripreso con `--resume`: il contesto è già nella conversazione CLI. */
export function buildRefineResumePrompt(openingText: string): string {
  return openingText;
}
