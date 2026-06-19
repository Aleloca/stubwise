import { z } from "zod";

/**
 * Parser dell'output del comando `/usage` della TUI di claude (già ripulito dai
 * codici ANSI da usage-pty.ts). Espone l'utilizzo residuo dell'abbonamento in
 * due finestre: la SESSIONE (rolling 5h) e il limite SETTIMANALE.
 *
 * Strategia a due livelli, tutta BEST-EFFORT (non lancia mai, ritorna null sui
 * casi che non sa interpretare):
 *  1. `parseUsageDeterministic` — regex a BLOCCHI sul blob intero. Affidabile e
 *     gratuito, ma fragile a cambi di layout tra versioni del CLI. Lavora sul
 *     blob (non per righe) perché la TUI usa il cursor positioning, non `\n`:
 *     dopo lo strip ANSI le righe risultano concatenate; il parser è robusto a
 *     questo formato isolando il blocco di ogni sezione via lookahead.
 *  2. `parseUsageWithLlm` — fallback che fa estrarre lo snapshot a un modello
 *     economico (haiku), validando l'output con zod + sanity check. Più robusto
 *     ai cambi di layout, ma costa una chiamata.
 * Il combinatore `parseUsage` prova prima il deterministico; solo se fallisce
 * ricade sull'LLM. `parseOk=true` SOLO quando il deterministico ha funzionato:
 * un fallback LLM riuscito segnala comunque che il parser deterministico è da
 * aggiornare (parseOk=false, source="llm_fallback").
 *
 * Forma di UsageSnapshot — SCELTA: il `/usage` REALE di claude mostra ogni
 * finestra come una barra `█...  N% used` (percentuale sulla STESSA riga della
 * barra) seguita da una riga `Resets <label>`. Modelliamo quindi il residuo
 * come percentuale: `{ percentUsed, percentRemaining }` (uno è il complemento
 * dell'altro, ridondante ma comodo lato dashboard) PIÙ `resetsLabel`, l'orario
 * di reset così come lo mostra la TUI ("2:39pm (Europe/Rome)", "Jun 22 at
 * 9:59am (Europe/Rome)"): è una LABEL testuale, non una data ISO, e la
 * conserviamo tale-e-quale senza forzare conversioni inaffidabili. I campi ISO
 * `sessionResetAt`/`weeklyResetAt` restano per compatibilità ma il
 * deterministico li lascia null (la TUI non emette ISO).
 */

/**
 * Residuo di una finestra come percentuali (0–100), complementari, più la
 * label testuale del reset così come mostrata dalla TUI (non-ISO, opzionale).
 */
export interface UsageWindow {
  percentUsed: number;
  percentRemaining: number;
  /** Orario di reset come label testuale della TUI (non-ISO), o null/assente. */
  resetsLabel?: string | null;
}

export interface UsageSnapshot {
  /** Residuo della finestra di sessione (rolling 5h). */
  sessionRemaining: UsageWindow;
  /** Residuo della finestra settimanale (tutti i modelli). */
  weeklyRemaining: UsageWindow;
  /** Istante di reset della sessione, ISO 8601, se noto (la TUI non lo fornisce). */
  sessionResetAt?: string | null;
  /** Istante di reset settimanale, ISO 8601, se noto (la TUI non lo fornisce). */
  weeklyResetAt?: string | null;
}

export interface ParseUsageResult {
  /** Snapshot estratto, o null se nessuna strategia ha funzionato. */
  snapshot: UsageSnapshot | null;
  /** Da quale strategia proviene il dato. */
  source: "deterministic" | "llm_fallback";
  /** true SOLO se il parser deterministico ha funzionato. */
  parseOk: boolean;
}

/** Funzione iniettabile che esegue la chiamata LLM e ritorna il JSON grezzo. */
export type RunLlm = (prompt: string) => Promise<string>;

const clampPercent = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

/**
 * Costruisce una finestra a partire dalla percentuale USATA e (opzionale) dalla
 * label di reset, derivando il complemento (0–100).
 */
function windowFrom(percentUsed: number, resetsLabel: string | null): UsageWindow {
  const used = clampPercent(percentUsed);
  return { percentUsed: used, percentRemaining: clampPercent(100 - used), resetsLabel };
}

/**
 * Estrae la percentuale "N% used" da un blocco di testo (la PRIMA occorrenza).
 * Tollerante a zero spazi: matcha sia "13% used" sia "13%used". → undefined se
 * assente.
 */
function matchPercentUsed(block: string): number | undefined {
  const m = block.match(/(\d{1,3})\s*%\s*used/i);
  return m?.[1] !== undefined ? Number(m[1]) : undefined;
}

/**
 * Estrae la label di reset da un blocco (la PRIMA occorrenza di "Resets ...").
 * Cattura SOLO fino a fine riga (niente flag `s`): col formato a newline si
 * ferma a fine riga; nel blob il blocco è già delimitato dai boundary di
 * sezione, quindi cattura es. "5:40pm (UTC)" senza sconfinare. Trimma; se vuota
 * → undefined.
 */
function matchResetsLabel(block: string): string | undefined {
  const m = block.match(/Resets\s+(.+)/i);
  const label = m?.[1]?.trim();
  return label !== undefined && label !== "" ? label : undefined;
}

/**
 * Costruisce una UsageWindow da un blocco di testo: estrae percentuale (PRIMA
 * `N% used`) e resetsLabel (opzionale). Se manca la percentuale → undefined
 * (finestra invalida).
 */
function readWindowFromBlock(block: string): UsageWindow | undefined {
  const percentUsed = matchPercentUsed(block);
  if (percentUsed === undefined) return undefined;
  return windowFrom(percentUsed, matchResetsLabel(block) ?? null);
}

/**
 * Parser deterministico per il formato REALE del `/usage`:
 *  - "Current session"            → percentuale e reset della sessione (5h)
 *  - "Current week (all models)"  → percentuale e reset della settimanale.
 *
 * Lavora A BLOCCHI SUL BLOB INTERO, non per righe: la cattura PTY di una TUI a
 * schermo intero dispone il testo col POSIZIONAMENTO DEL CURSORE (sequenze
 * ANSI), non con `\n`. Dopo lo strip ANSI etichetta + barra + percentuale +
 * "Resets" risultano CONCATENATE sulla stessa "riga". Isolando il BLOCCO di
 * ogni sezione via lookahead sul boundary della sezione successiva, il parser è
 * robusto SIA al formato con newline (test storici) SIA al blob concatenato
 * (cattura reale).
 *
 * L'ancoraggio della weekly su "(all models)" GARANTISCE di non leggere
 * "Current week (Sonnet only)". Richiede ENTRAMBE le percentuali (session +
 * weekly all-models): se ne manca una → null. La resetsLabel è opzionale.
 * BEST-EFFORT: non lancia mai; input non-stringa o vuoto → null.
 */
export function parseUsageDeterministic(text: string): UsageSnapshot | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  // Blocco sessione: da "Current session" fino alla sezione successiva
  // ("Current week" / "What's contributing") o fine stringa.
  const sessionBlock = text.match(
    /Current session\b([\s\S]*?)(?=Current week|What['’]s contributing|$)/i,
  )?.[1];
  // Blocco weekly: ancorato a "(all models)" per non agganciare "Sonnet only".
  const weeklyBlock = text.match(
    /Current week\s*\(all models\)([\s\S]*?)(?=Current week|What['’]s contributing|$)/i,
  )?.[1];
  // Servono ENTRAMBI i blocchi.
  if (sessionBlock === undefined || weeklyBlock === undefined) return null;

  const session = readWindowFromBlock(sessionBlock);
  const weekly = readWindowFromBlock(weeklyBlock);
  if (!session || !weekly) return null;

  return { sessionRemaining: session, weeklyRemaining: weekly };
}

// Schema zod dell'output atteso dall'LLM. Chiediamo solo `percentUsed` (0–100)
// più una `resetsLabel` testuale opzionale: il complemento lo deriviamo noi.
const llmWindowSchema = z.object({
  percentUsed: z.number(),
  resetsLabel: z.string().nullish(),
});
const llmSnapshotSchema = z.object({
  sessionRemaining: llmWindowSchema,
  weeklyRemaining: llmWindowSchema,
});

/** Una percentuale è plausibile se è un numero finito in [0,100]. */
function plausiblePercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

/**
 * Fallback LLM: chiama `runLlm(prompt)` (iniettabile), parsa il JSON, lo valida
 * con zod e applica un sanity check (percentuali in 0–100 → altrimenti scarta
 * tutto, segnale di allucinazione). La resetsLabel è una stringa testuale
 * (non-ISO): la conserviamo tale-e-quale. BEST-EFFORT: qualunque errore (runLlm
 * che lancia, JSON malformato, validazione fallita) → null, mai propagato.
 */
export async function parseUsageWithLlm(
  text: string,
  runLlm: RunLlm,
): Promise<UsageSnapshot | null> {
  let raw: string;
  try {
    raw = await runLlm(buildLlmPrompt(text));
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = llmSnapshotSchema.safeParse(parsedJson);
  if (!result.success) return null;
  const data = result.data;

  // Sanity check sui numeri: fuori da 0–100 → allucinazione, scarta tutto.
  if (!plausiblePercent(data.sessionRemaining.percentUsed)) return null;
  if (!plausiblePercent(data.weeklyRemaining.percentUsed)) return null;

  return {
    sessionRemaining: windowFrom(
      data.sessionRemaining.percentUsed,
      data.sessionRemaining.resetsLabel ?? null,
    ),
    weeklyRemaining: windowFrom(
      data.weeklyRemaining.percentUsed,
      data.weeklyRemaining.resetsLabel ?? null,
    ),
    sessionResetAt: null,
    weeklyResetAt: null,
  };
}

/** Istruzioni per il modello economico: estrai gli usage in JSON con lo schema. */
function buildLlmPrompt(rawUsageText: string): string {
  return [
    "You are given the raw text output of the Claude Code `/usage` command.",
    "Extract the usage for the SESSION window (\"Current session\") and the",
    "WEEKLY window (\"Current week (all models)\" — NOT \"Sonnet only\").",
    "For each window read the percentage shown as 'N% used' and the reset time",
    "shown on the following 'Resets ...' line (a human label, keep it verbatim).",
    "Respond with ONLY a JSON object, no prose, with this exact shape:",
    "{",
    '  "sessionRemaining": { "percentUsed": <0-100>, "resetsLabel": <string or null> },',
    '  "weeklyRemaining":  { "percentUsed": <0-100>, "resetsLabel": <string or null> }',
    "}",
    "Use null for resetsLabel if no reset line is shown for that window.",
    "Keep resetsLabel exactly as printed (e.g. \"2:39pm (Europe/Rome)\").",
    "",
    "--- /usage output ---",
    rawUsageText,
    "--- end ---",
  ].join("\n");
}

/**
 * Combinatore: prova il deterministico; se null ricade sull'LLM. `parseOk` è
 * true SOLO sul deterministico — un fallback LLM riuscito segnala comunque che
 * il parser deterministico è da aggiornare. BEST-EFFORT: non lancia mai.
 */
export async function parseUsage(text: string, runLlm: RunLlm): Promise<ParseUsageResult> {
  const deterministic = parseUsageDeterministic(text);
  if (deterministic !== null) {
    return { snapshot: deterministic, source: "deterministic", parseOk: true };
  }
  const llm = await parseUsageWithLlm(text, runLlm);
  return { snapshot: llm, source: "llm_fallback", parseOk: false };
}
