/**
 * Cuore RAG condiviso sui Docs di un progetto (M6.5).
 *
 * Questo modulo isola le parti del flusso RAG che NON dipendono dal trasporto
 * (streaming SSE, sessione/persistenza, AbortSignal) così possono essere riusate
 * da più consumatori:
 *  - la chat web ({@link ../routes/docs-chat.ts}) — streaming + history + sessione;
 *  - integrazioni one-shot (es. Slack) — accumulo non-streaming, nessuna history.
 *
 * Espone:
 *  - {@link buildDocsSystemPrompt}: il system prompt anti-allucinazione + doppio
 *    registro + obbligo citazioni (UNICA definizione, condivisa);
 *  - {@link buildCitations}: dedup delle citazioni per slug (UNICA definizione);
 *  - {@link answerDocsQuestion}: il flusso RAG completo NON-streaming (retrieval →
 *    prompt → accumulo dello stream LLM → testo + citazioni).
 *
 * Il retrieval (scope/ranking) resta in {@link ./docs-retrieval.ts}: qui lo si
 * richiama con gli stessi parametri della chat web.
 */

import type { ChatLlm } from "./chat-llm.js";
import { retrieveChunks, type RetrievedChunk } from "./docs-retrieval.js";
import type { EmbeddingClient } from "@stubwise/embeddings";
import type { Db } from "@stubwise/db";

/** Citazione restituita alla UI / persistita / postata: riferimento a una pagina doc. */
export interface Citation {
  slug: string;
  title: string;
  kind: RetrievedChunk["kind"];
  /**
   * Repository d'origine della pagina citata. Valorizzato sia nella chat per-repo
   * (costante) sia in quella cross-repo di progetto (Fase 2), dove disambigua da
   * QUALE repository proviene la fonte (link "Fonti" col `repositoryId`, nome repo
   * nella UI/Slack).
   */
  repositoryId: string;
  repositorySlug: string;
  repositoryName: string;
}

/** Numero di pagine di contesto recuperate per la chat/RAG. */
export const CHAT_RETRIEVAL_K = 8;

/**
 * System prompt della chat RAG. Codifica i requisiti di prodotto:
 *  - DOPPIO REGISTRO: domanda tecnica → risposta tecnica con moduli/API;
 *    domanda capability ("si può fare X") → risposta funzionale con i passi se
 *    fattibile, oppure il perché non lo è.
 *  - ANTI-ALLUCINAZIONE: rispondere SOLO dal contesto recuperato; se non basta,
 *    dirlo esplicitamente invece di inventare.
 *  - CITAZIONI: citare le pagine usate (per slug/titolo).
 *
 * Il contesto recuperato è incluso in coda al prompt, con slug/titolo per ogni
 * pagina così il modello può citarle.
 */
export function buildDocsSystemPrompt(chunks: RetrievedChunk[]): string {
  const header = [
    "Sei l'assistente di documentazione di un progetto software. Rispondi nella lingua della domanda.",
    "",
    "ADATTA IL REGISTRO ALLA DOMANDA:",
    '- Domanda TECNICA ("come funziona X?", "dove sta Y?") → risposta tecnica, con riferimenti a moduli, API pubbliche e flussi reali presenti nel contesto.',
    '- Domanda di CAPABILITY ("si può fare X?", "è possibile Y?") → risposta funzionale: se è fattibile descrivi i passi; se NON è fattibile spiega il perché, sempre ancorato a cosa il codice/documentazione effettivamente fa.',
    "",
    "RISPONDI SOLO DAL CONTESTO RECUPERATO QUI SOTTO. Non inventare: se il contesto non basta a rispondere, dillo esplicitamente (es. \"La documentazione recuperata non copre questo punto\") invece di tirare a indovinare.",
    "",
    "Il contesto può provenire da PIÙ REPOSITORY dello stesso progetto: ogni fonte indica il repository di appartenenza. DISAMBIGUA per repository quando ti riferisci a moduli/concetti omonimi, e indica il repository pertinente nella risposta.",
    "",
    "CITA SEMPRE le pagine di documentazione che hai usato, riferendoti al loro titolo e al repository di appartenenza.",
    "",
    "--- CONTESTO RECUPERATO ---",
  ];

  if (chunks.length === 0) {
    header.push("(nessuna pagina di documentazione rilevante è stata trovata per questa domanda)");
    return header.join("\n");
  }

  const context = chunks.map((c, i) => {
    return [
      `[${i + 1}] Repository "${c.repositoryName}" — Pagina "${c.title}" (slug: ${c.slug}, tipo: ${c.kind})`,
      c.snippet,
    ].join("\n");
  });

  return [...header, ...context].join("\n\n");
}

/**
 * Deriva le citazioni (una per pagina) dai chunk recuperati, deduplicate per
 * `(repositoryId, slug)`: nel retrieval cross-repo di progetto pagine di repo
 * DIVERSI possono condividere lo stesso slug (gli slug sono unici per-repo, non
 * globalmente), quindi la chiave di dedup include il repository.
 */
export function buildCitations(chunks: RetrievedChunk[]): Citation[] {
  const byKey = new Map<string, Citation>();
  for (const c of chunks) {
    const key = `${c.repositoryId}:${c.slug}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        slug: c.slug,
        title: c.title,
        kind: c.kind,
        repositoryId: c.repositoryId,
        repositorySlug: c.repositorySlug,
        repositoryName: c.repositoryName,
      });
    }
  }
  return [...byKey.values()];
}

/** Risposta RAG non-streaming: testo accumulato + citazioni. */
export interface DocsAnswer {
  text: string;
  citations: Citation[];
}

/**
 * Flusso RAG completo NON-streaming per una singola domanda one-shot (es. Slack).
 *
 * Stesso cuore della chat web ({@link ../routes/docs-chat.ts}) — stesso retrieval
 * (k = {@link CHAT_RETRIEVAL_K}), stesso system prompt, stesse citazioni — ma:
 *  - NESSUNA history: il `messages` contiene solo la domanda utente (Slack è
 *    one-shot, niente sessione multi-turn);
 *  - NESSUN AbortSignal: la generazione non è interrompibile da un client che si
 *    disconnette (one-shot);
 *  - ACCUMULO dello stream invece dell'inoltro frammento-per-frammento: i delta
 *    del {@link ChatLlm} sono concatenati e restituiti come testo completo.
 */
export async function answerDocsQuestion(
  deps: { db: Db; embeddingClient: EmbeddingClient; chatLlm: ChatLlm },
  input: { repositoryId: string; question: string },
): Promise<DocsAnswer> {
  const chunks = await retrieveChunks(
    deps.db,
    deps.embeddingClient,
    input.repositoryId,
    input.question,
    { k: CHAT_RETRIEVAL_K },
  );

  const system = buildDocsSystemPrompt(chunks);
  // Niente history: solo la domanda corrente come unico messaggio utente.
  const messages = [{ role: "user" as const, content: input.question }];

  // Accumula lo stream: Slack non stremma, vuole il testo completo in una volta.
  let text = "";
  for await (const delta of deps.chatLlm.stream({ system, messages })) {
    text += delta;
  }

  return { text, citations: buildCitations(chunks) };
}
