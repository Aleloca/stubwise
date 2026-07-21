import type { RetrievedChunk } from "@stubwise/db";

/**
 * Prompt dell'intake del backlog di discovery.
 *
 * Due chiamate one-shot all'agente:
 *  - {@link buildIntakePrompt}: da un feedback (titolo+corpo di un ticket o di
 *    un'idea manuale) + il contesto RAG del progetto, produce la PRIMA versione
 *    di una voce del backlog (titolo, documento, stime effort/rischio/urgenza).
 *  - {@link buildMergePrompt}: integra un NUOVO feedback nel documento di una
 *    voce esistente (dedup automatico sopra la soglia di merge).
 *
 * Entrambi chiedono un OUTPUT JSON, parsato in modo difensivo da intake.ts. Lo
 * stile ricalca i prompt della chat/aggiorna-documento del server
 * (`apps/server/src/routes/backlog-rag.ts`): stesso ruolo "co-progettista di
 * prodotto", stessa struttura del documento (Contesto, Cosa fare, Punti aperti).
 *
 * PROMPT INJECTION: titolo/corpo del feedback e documenti sono input NON FIDATO
 * (chi apre un ticket ne controlla il contenuto). Contenuto per costruzione: i
 * run girano in `permissionMode: "default"` (in headless nega ciò che
 * richiederebbe approvazione) su una dir vuota (nessun worktree). NON si usa
 * "plan": è la modalità di ESPLORAZIONE read-only e invita l'agente a leggere
 * il filesystem del container (Read/Grep/Glob) — un feedback ostile potrebbe
 * indurlo a leggere file sensibili (es. /proc/self/environ) con canale di
 * ritorno via title → commento sul ticket. L'intake non usa tool per design:
 * tutto il contesto è già nel prompt. Caso peggiore residuo: una voce del
 * backlog dal contenuto fuorviante, mai un'azione sul sistema.
 */

/** Blocco delle pagine di documentazione recuperate (con slug/titolo per citarle). */
function docsContextBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "(nessuna pagina di documentazione rilevante è stata trovata)";
  }
  return chunks
    .map((c, i) =>
      [
        `[${i + 1}] Repository "${c.repositoryName}" — Pagina "${c.title}" (slug: ${c.slug})`,
        c.snippet,
      ].join("\n"),
    )
    .join("\n\n");
}

/** Feedback in ingresso all'intake: titolo + corpo, con l'eventuale numero del
 * ticket d'origine (assente per le idee manuali). */
export interface IntakeInput {
  title: string;
  body: string;
  /** Numero del ticket d'origine, se l'intake nasce da un ticket. */
  ticketNumber?: number;
}

/**
 * Prompt per la PRIMA elaborazione di una voce del backlog. L'agente riceve il
 * feedback grezzo + il contesto RAG del progetto e produce titolo, documento e
 * stime. OUTPUT JSON `{ title, document, effort, risk, riskNote?, urgency }`.
 */
export function buildIntakePrompt(input: IntakeInput, chunks: RetrievedChunk[]): string {
  const origin =
    input.ticketNumber !== undefined
      ? `Questo feedback proviene dal ticket #${input.ticketNumber}.`
      : `Questo feedback è un'idea proposta manualmente (nessun ticket d'origine).`;
  return [
    "Sei un co-progettista di prodotto. Trasforma un feedback grezzo in una voce del backlog di discovery: un documento di design conciso e una prima stima dei metadati.",
    origin,
    "",
    "ANCORATI AL CONTESTO: appòggiati alla documentazione del progetto qui sotto per capire come funziona già il prodotto. Se la documentazione non copre un punto, non inventare: elencalo tra i punti aperti.",
    "",
    "IL DOCUMENTO (Markdown) deve avere queste sezioni:",
    "- **Contesto**: qual è il problema/bisogno e da dove nasce.",
    "- **Cosa fare**: la proposta a grandi linee (non un piano tecnico di dettaglio).",
    "- **Punti aperti**: domande, dubbi, decisioni da prendere.",
    "",
    "LE STIME:",
    "- `effort` è lo sforzo su scala 1–5: 1 = poche ore, 2 = un giorno, 3 = qualche giorno, 4 = una-due settimane, 5 = oltre / molto incerto.",
    "- `risk` è low|medium|high (rischio tecnico/di regressione); `riskNote` spiega brevemente il rischio se non è low.",
    "- `urgency` è low|medium|high|urgent.",
    "Stima con quello che sai; nel dubbio resta conservativo e segnala l'incertezza nei punti aperti.",
    "",
    "FORMATO DI OUTPUT (OBBLIGATORIO): un unico oggetto JSON valido, senza testo attorno, della forma:",
    '{ "title": "<titolo sintetico>", "document": "<markdown del documento>", "effort": <1-5>, "risk": "low"|"medium"|"high", "riskNote": "<nota, opzionale>", "urgency": "low"|"medium"|"high"|"urgent" }',
    'Ometti "riskNote" se il rischio è low o non hai nulla da aggiungere.',
    "",
    `--- FEEDBACK: TITOLO ---\n${input.title}`,
    "",
    `--- FEEDBACK: CORPO ---\n${input.body || "(nessun corpo)"}`,
    "",
    `--- DOCUMENTAZIONE DEL PROGETTO ---\n${docsContextBlock(chunks)}`,
  ].join("\n");
}

/**
 * Prompt per FONDERE un nuovo feedback nel documento di una voce esistente
 * (dedup automatico). L'agente integra ciò che il nuovo feedback AGGIUNGE senza
 * perdere il contenuto valido. OUTPUT JSON `{ document }` (solo il documento
 * aggiornato: i metadati della voce NON si toccano in automatico).
 */
export function buildMergePrompt(currentDocument: string, newFeedback: string): string {
  return [
    "Sei un co-progettista di prodotto. Una voce del backlog di discovery ha ricevuto un NUOVO feedback che descrive la stessa idea. Integra nel documento esistente ciò che il nuovo feedback aggiunge (nuovi requisiti, casi, vincoli, punti aperti), senza perdere ciò che è già valido.",
    "",
    "REGOLE:",
    "- Mantieni la struttura Markdown esistente (Contesto, Cosa fare, Punti aperti).",
    "- Niente duplicati: unisci i punti equivalenti; aggiungi solo ciò che è nuovo.",
    "- Se il nuovo feedback non aggiunge nulla di sostanziale, restituisci il documento sostanzialmente invariato.",
    "",
    "FORMATO DI OUTPUT (OBBLIGATORIO): un unico oggetto JSON valido, senza testo attorno, della forma:",
    '{ "document": "<markdown completo del documento aggiornato>" }',
    "",
    `--- DOCUMENTO CORRENTE ---\n${currentDocument || "(vuoto)"}`,
    "",
    `--- NUOVO FEEDBACK ---\n${newFeedback}`,
  ].join("\n");
}

/** Voce del backlog in ingresso al deep dive: documento e metadati correnti. */
export interface DeepDiveInput {
  title: string;
  document: string;
  effort: number | null;
  risk: string | null;
  urgency: string | null;
}

/**
 * Prompt del DEEP DIVE (approfondimento tecnico sul repo collegato). A DIFFERENZA
 * dell'intake/merge, questo run gira in `permissionMode: "plan"` su un WORKTREE
 * del mirror (pattern PR review): l'agente DEVE leggere il codice reale (Read/
 * Grep/Glob) per validare la fattibilità dell'idea. Il documento della voce è
 * input non fidato, ma qui il caso peggiore è che l'agente legga il repo (che sta
 * già leggendo per design) — nessuna scrittura, nessun push. L'output è JSON
 * `{ analysis, suggested }`: `analysis` è il markdown della sezione "Analisi
 * tecnica", `suggested` sono i metadati proposti (mai applicati in automatico).
 */
export function buildDeepDivePrompt(input: DeepDiveInput): string {
  const meta = [
    `- effort attuale: ${input.effort ?? "non stimato"} (scala 1–5)`,
    `- rischio attuale: ${input.risk ?? "non stimato"}`,
    `- urgenza attuale: ${input.urgency ?? "non stimata"}`,
  ].join("\n");
  return [
    "Sei un ingegnere senior che valuta la fattibilità tecnica di una voce del backlog di discovery. Ti trovi nella radice del repository collegato (working tree read-only): ESPLORA il codice reale (Read/Grep/Glob) per fondare la tua analisi sui fatti, non su ipotesi.",
    "",
    "OBIETTIVO: produrre una sezione 'Analisi tecnica' che risponda a:",
    "- **Fattibilità**: l'idea è realizzabile con l'architettura attuale? Cosa la rende facile o difficile?",
    "- **Punti di contatto**: quali file/moduli/componenti concreti andrebbero toccati o estesi (cita percorsi reali che hai visto nel repo).",
    "- **Rischi di regressione**: quali comportamenti esistenti rischiano di rompersi, con riferimenti concreti al codice (non generici).",
    "- **Nodi aperti**: decisioni tecniche o incognite emerse dall'esplorazione.",
    "",
    "Poi RIVEDI le stime alla luce di ciò che hai visto e proponi (senza applicarle) i metadati aggiornati: effort (1–5), risk (low|medium|high) con una breve nota, urgency (low|medium|high|urgent). Proponi SOLO i campi per cui hai un parere motivato; ometti gli altri. `reason` spiega in una frase il perché delle proposte.",
    "",
    "FORMATO DI OUTPUT (OBBLIGATORIO): un unico oggetto JSON valido, senza testo attorno, della forma:",
    '{ "analysis": "<markdown della sezione Analisi tecnica>", "suggested": { "effort": <1-5>, "risk": "low"|"medium"|"high", "riskNote": "<nota>", "urgency": "low"|"medium"|"high"|"urgent", "reason": "<motivazione>" } }',
    'Il markdown di "analysis" NON deve includere l\'intestazione "## Analisi tecnica" (viene aggiunta automaticamente) e per i sottotitoli deve usare al massimo il livello 3 (`###`), MAI `##` (romperebbe la struttura del documento). Ometti da "suggested" i campi su cui non hai un parere; se non proponi nulla, restituisci `"suggested": {}`.',
    "",
    `--- VOCE: TITOLO ---\n${input.title}`,
    "",
    `--- VOCE: METADATI CORRENTI ---\n${meta}`,
    "",
    `--- VOCE: DOCUMENTO ---\n${input.document || "(vuoto)"}`,
  ].join("\n");
}
