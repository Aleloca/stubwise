import { z } from "zod";

/**
 * Parser dell'output del comando `/usage` della TUI di claude (già ripulito dai
 * codici ANSI da usage-pty.ts). Espone l'utilizzo residuo dell'abbonamento in
 * due finestre: la SESSIONE (rolling 5h) e il limite SETTIMANALE.
 *
 * Strategia a due livelli, tutta BEST-EFFORT (non lancia mai, ritorna null sui
 * casi che non sa interpretare):
 *  1. `parseUsageDeterministic` — regex sul formato noto della TUI. Affidabile e
 *     gratuito, ma fragile a cambi di layout tra versioni del CLI.
 *  2. `parseUsageWithLlm` — fallback che fa estrarre lo snapshot a un modello
 *     economico (haiku), validando l'output con zod + sanity check. Più robusto
 *     ai cambi di layout, ma costa una chiamata.
 * Il combinatore `parseUsage` prova prima il deterministico; solo se fallisce
 * ricade sull'LLM. `parseOk=true` SOLO quando il deterministico ha funzionato:
 * un fallback LLM riuscito segnala comunque che il parser deterministico è da
 * aggiornare (parseOk=false, source="llm_fallback").
 *
 * Forma di UsageSnapshot — SCELTA: il `/usage` di claude mostra ogni finestra
 * come "N% used" (più una barra e un orario di reset). Modelliamo quindi il
 * residuo come percentuale: `{ percentUsed, percentRemaining }` (uno è il
 * complemento dell'altro, ridondante ma comodo lato dashboard). I reset sono
 * ISO 8601 opzionali: la TUI li mostra spesso in forma relativa/locale ("in 2h",
 * "3:00pm") difficile da rendere assoluta in modo affidabile dal solo testo, per
 * cui il deterministico li lascia tipicamente assenti e l'LLM li popola solo se
 * riesce a produrre un ISO valido.
 */

/** Residuo di una finestra come percentuali (0–100), complementari. */
export interface UsageWindow {
  percentUsed: number;
  percentRemaining: number;
}

export interface UsageSnapshot {
  /** Residuo della finestra di sessione (rolling 5h). */
  sessionRemaining: UsageWindow;
  /** Residuo della finestra settimanale (tutti i modelli). */
  weeklyRemaining: UsageWindow;
  /** Istante di reset della sessione, ISO 8601, se noto. */
  sessionResetAt?: string | null;
  /** Istante di reset della finestra settimanale, ISO 8601, se noto. */
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
 * Dato un valore percentuale e se rappresenta "used" o "remaining", costruisce
 * la finestra con entrambe le facce (complementari, 0–100).
 */
function windowFrom(percent: number, kind: "used" | "remaining"): UsageWindow {
  const value = clampPercent(percent);
  return kind === "used"
    ? { percentUsed: value, percentRemaining: clampPercent(100 - value) }
    : { percentUsed: clampPercent(100 - value), percentRemaining: value };
}

/**
 * Cerca, in un blocco di testo, una percentuale seguita o preceduta da "used" /
 * "remaining" / "left". Ritorna la prima trovata, o undefined.
 */
function matchWindow(block: string): UsageWindow | undefined {
  // "42% used" / "42 % used"
  const used = block.match(/(\d{1,3})\s*%\s*used/i);
  if (used?.[1]) return windowFrom(Number(used[1]), "used");
  // "90% remaining" / "90% left"
  const remaining = block.match(/(\d{1,3})\s*%\s*(?:remaining|left)/i);
  if (remaining?.[1]) return windowFrom(Number(remaining[1]), "remaining");
  return undefined;
}

/**
 * Parser deterministico. Individua i blocchi di "sessione" e "settimanale" per
 * parola chiave e ne estrae la percentuale. Richiede ENTRAMBE le finestre:
 * trovarne una sola è troppo poco affidabile per fidarsi → null.
 */
export function parseUsageDeterministic(text: string): UsageSnapshot | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  const lines = text.split(/\r?\n/);

  // Trova l'indice della riga "etichetta" che contiene una keyword, poi cerca
  // la percentuale nella stessa riga o in quelle immediatamente successive.
  const findWindow = (keywords: RegExp): UsageWindow | undefined => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || !keywords.test(line)) continue;
      // Stessa riga (es. "Current session: 90% remaining").
      const here = matchWindow(line);
      if (here) return here;
      // Righe successive fino a 3 (etichetta, barra, percentuale).
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const next = lines[j];
        if (next === undefined) continue;
        const found = matchWindow(next);
        if (found) return found;
      }
    }
    return undefined;
  };

  const session = findWindow(/\bsession\b/i);
  // "weekly" o "week" (limite settimanale). Evitiamo di confondere con session.
  const weekly = findWindow(/\bweek(?:ly)?\b/i);
  if (!session || !weekly) return null;

  return { sessionRemaining: session, weeklyRemaining: weekly };
}

// Schema zod dell'output atteso dall'LLM. additionalProperties non vincolato:
// validiamo solo i campi che ci servono. I reset sono opzionali/nullable.
const usageWindowSchema = z.object({
  percentUsed: z.number(),
  percentRemaining: z.number(),
});
const llmSnapshotSchema = z.object({
  sessionRemaining: usageWindowSchema,
  weeklyRemaining: usageWindowSchema,
  sessionResetAt: z.string().nullish(),
  weeklyResetAt: z.string().nullish(),
});

/** Una percentuale è plausibile se è un numero finito in [0,100]. */
function plausiblePercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

function plausibleWindow(w: UsageWindow): boolean {
  return plausiblePercent(w.percentUsed) && plausiblePercent(w.percentRemaining);
}

/**
 * Valida una stringa ISO: deve essere parsabile come data. Ritorna l'ISO
 * normalizzato (toISOString) o null se non è una data valida.
 */
function normalizeIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Fallback LLM: chiama `runLlm(prompt)` (iniettabile), parsa il JSON, lo valida
 * con zod e applica un sanity check (percentuali in 0–100; reset, se presenti,
 * date ISO valide → altrimenti l'intero snapshot è scartato perché segnale che
 * il modello ha allucinato). BEST-EFFORT: qualunque errore (runLlm che lancia,
 * JSON malformato, validazione fallita) → null, mai un'eccezione propagata.
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
  if (!plausibleWindow(data.sessionRemaining) || !plausibleWindow(data.weeklyRemaining)) {
    return null;
  }

  // Reset: se il modello ne ha prodotto uno NON parsabile come data, lo
  // trattiamo come allucinazione e scartiamo l'intero snapshot (un reset
  // inventato è peggio di un reset assente).
  const sessionResetRaw = data.sessionResetAt;
  const weeklyResetRaw = data.weeklyResetAt;
  const sessionResetAt = normalizeIso(sessionResetRaw);
  const weeklyResetAt = normalizeIso(weeklyResetRaw);
  if (typeof sessionResetRaw === "string" && sessionResetRaw !== "" && sessionResetAt === null) {
    return null;
  }
  if (typeof weeklyResetRaw === "string" && weeklyResetRaw !== "" && weeklyResetAt === null) {
    return null;
  }

  return {
    sessionRemaining: {
      percentUsed: clampPercent(data.sessionRemaining.percentUsed),
      percentRemaining: clampPercent(data.sessionRemaining.percentRemaining),
    },
    weeklyRemaining: {
      percentUsed: clampPercent(data.weeklyRemaining.percentUsed),
      percentRemaining: clampPercent(data.weeklyRemaining.percentRemaining),
    },
    sessionResetAt,
    weeklyResetAt,
  };
}

/** Istruzioni per il modello economico: estrai gli usage in JSON con lo schema. */
function buildLlmPrompt(rawUsageText: string): string {
  return [
    "You are given the raw text output of the Claude Code `/usage` command.",
    "Extract the remaining usage for the SESSION window (rolling 5h) and the",
    "WEEKLY window (all models). Respond with ONLY a JSON object, no prose, with",
    "this exact shape:",
    "{",
    '  "sessionRemaining": { "percentUsed": <0-100>, "percentRemaining": <0-100> },',
    '  "weeklyRemaining": { "percentUsed": <0-100>, "percentRemaining": <0-100> },',
    '  "sessionResetAt": <ISO 8601 string or null>,',
    '  "weeklyResetAt": <ISO 8601 string or null>',
    "}",
    "Use null for any reset time you cannot express as a valid ISO 8601 string.",
    "If a percentage is shown as 'used', set percentRemaining = 100 - used.",
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
