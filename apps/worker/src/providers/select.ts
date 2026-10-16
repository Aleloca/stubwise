import { aiProviders, decrypt, projects, type Db } from "@stubwise/db";
import { asc, eq, sql } from "drizzle-orm";
import type { AgentRunResult } from "../agent/runner.js";
import type { ResolvedProvider } from "./chain.js";
import { isLimitError, limitResetAt, ProviderLimitError } from "./limit.js";
import { latestSnapshots, MAX_SNAPSHOT_AGE_MS, parseWindow } from "./usage-window.js";

/**
 * Scelta dell'account per OGNI run `claude` del worker (design 2026-10-15 §4).
 * UN posto solo: fix, review, backlog, posta, brief, Docs, giro notturno — e la
 * decisione di ripresa del limit-resume-poller.
 *
 * Ordine: il provider del progetto (preferito; con `ai_provider_exclusive` E un
 * id valorizzato è l'unico), poi gli ABBONAMENTI abilitati in ordine di
 * position. La chiave API entra solo se è il provider del progetto, o se
 * l'istanza non ha nessun abbonamento abilitato (self-hosted con sola chiave):
 * il conteggio degli abbonamenti è fatto PRIMA dei filtri, quindi con tutti gli
 * abbonamenti al limite la chiave resta fuori (voluto, preflight D3). Esclusi:
 * gli account «al limite» (`limited_until` futuro) e, per i lavori di sfondo,
 * gli abbonamenti oltre la soglia settimanale secondo uno snapshot fresco.
 */
export type WorkClass = "interactive" | "background";

export interface SelectInput {
  projectId: string | null;
  workClass: WorkClass;
  /** Provider imposto come ESCLUSIVO (generazione Docs nata con «solo questo», Task A6). Assente = si legge il progetto. */
  pinnedProviderId?: string | null;
}

export interface SelectDeps {
  db: Db;
  encryptionKey: Buffer;
  backgroundWeeklyThreshold: number;
  now?: () => Date;
  log?: (m: string) => void;
  /** Iniettabile nei test che oggi finto-iniettano la catena (loadProviderChainFn/loadProviderByIdFn). Default: selectProviders. */
  selectProvidersFn?: (deps: SelectDeps, input: SelectInput) => Promise<ProviderSelection>;
  /** Iniettabile per i test con db finto. Default: markProviderLimited (su un id inesistente è un no-op). */
  markProviderLimitedFn?: (db: Db, providerId: string, until: Date) => Promise<void>;
  /**
   * «Al limite fino a» dell'AUTH STORICA del container (nessun provider
   * abilitato): non c'è una riga di `ai_providers` su cui scriverlo, quindi vive
   * qui, IN MEMORIA, condiviso da tutti i lavori del processo (index.ts crea UN
   * SelectDeps). Il worker è UN processo: un riavvio lo perde, e il costo è al
   * più UN run in più (finisce di nuovo al limite e lo riscrive). Assente =
   * nessuna memoria (test).
   */
  legacyLimit?: LegacyLimitState;
}

/** Stato in memoria del limite dell'auth storica (vedi SelectDeps.legacyLimit). */
export interface LegacyLimitState {
  until: Date | null;
}

export type EmptyReason =
  /** «solo questo» su un provider disabilitato o sparito → held `other`. */
  | "exclusive_unavailable"
  /** Tutti i candidati scartati alla decifratura → held `other`. */
  | "no_usable_provider"
  /** Tutti al limite (limited_until futuro) → held `limit`, ripresa automatica. */
  | "all_limited"
  /** Solo background: tutti oltre BACKGROUND_WEEKLY_THRESHOLD → in attesa. */
  | "all_over_threshold";

export interface ProviderSelection {
  /** Candidati in ordine di prova (decifrati). */
  candidates: ResolvedProvider[];
  /** Nessun provider abilitato: un tentativo con l'auth del container (comportamento storico). */
  legacyAuth: boolean;
  /** Perché la lista è vuota quando legacyAuth è falso. */
  emptyReason: EmptyReason | null;
}

export type ProviderRun<T> =
  | { kind: "done"; value: T; provider: ResolvedProvider | undefined }
  /** Auth storica (catena vuota) e run finito al limite: niente da marcare, il chiamante mette in attesa (fix: holdAllProvidersLimited). */
  /** `value` assente quando il tentativo ha LANCIATO l'errore di limite (ProviderLimitError) invece di restituire un esito. */
  | { kind: "legacy_limited"; value?: T; limitText: string }
  | { kind: "unavailable"; reason: EmptyReason | "all_limited_now" };

export interface RunWithProvidersHooks {
  /** A ogni account trovato al limite durante i tentativi (riga di log del job: «provider i/N al limite»). index è 1-based. */
  onLimited?: (provider: ResolvedProvider, index: number, total: number) => void | Promise<void>;
}

/** Attesa quando il testo del limite non ha un'ora e lo snapshot non aiuta: mai «al limite per sempre». */
const LIMIT_FALLBACK_MS = 60 * 60_000;

export async function selectProviders(
  deps: SelectDeps,
  input: SelectInput,
): Promise<ProviderSelection> {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select({
      id: aiProviders.id,
      kind: aiProviders.kind,
      label: aiProviders.label,
      secretEncrypted: aiProviders.secretEncrypted,
      limitedUntil: aiProviders.limitedUntil,
    })
    .from(aiProviders)
    .where(eq(aiProviders.enabled, true))
    .orderBy(asc(aiProviders.position));

  // Un pin esplicito (generazione Docs nata con «solo questo») vince sul progetto.
  const [pref]: Array<{ id: string | null; exclusive: boolean }> = input.pinnedProviderId
    ? [{ id: input.pinnedProviderId, exclusive: true }]
    : input.projectId === null
      ? []
      : await deps.db
          .select({ id: projects.aiProviderId, exclusive: projects.aiProviderExclusive })
          .from(projects)
          .where(eq(projects.id, input.projectId));
  // «Solo questo» vale solo con un id: ON DELETE SET NULL può lasciare
  // exclusive=true con id nullo, e quello vale «preferito assente» (preflight D1).
  const exclusive = pref?.exclusive === true && pref.id != null;
  const preferred = pref?.id ? rows.find((r) => r.id === pref.id) : undefined;
  // «Solo questo» su un provider disabilitato o sparito vale anche quando
  // NESSUN provider è abilitato: l'auth storica del container non è il
  // provider che il progetto ha scelto come unico.
  if (exclusive && !preferred) {
    return { candidates: [], legacyAuth: false, emptyReason: "exclusive_unavailable" };
  }
  if (rows.length === 0) {
    // Auth storica finita al limite: finché l'ora non passa la scelta è VUOTA
    // per quota (come «tutti al limite»), così nessun run riparte per finire
    // subito di nuovo al limite e la ripresa aspetta la stessa ora.
    const until = deps.legacyLimit?.until;
    if (until && until.getTime() > now.getTime()) {
      return { candidates: [], legacyAuth: false, emptyReason: "all_limited" };
    }
    return { candidates: [], legacyAuth: true, emptyReason: null };
  }

  // Conteggio degli abbonamenti PRIMA dei filtri (preflight D3).
  const hasAccount = rows.some((r) => r.kind === "account");
  const others = exclusive
    ? []
    : rows.filter((r) => r.id !== preferred?.id && (r.kind === "account" || !hasAccount));
  let ordered = [...(preferred ? [preferred] : []), ...others];

  ordered = ordered.filter(
    (r) => r.limitedUntil === null || r.limitedUntil.getTime() <= now.getTime(),
  );
  if (ordered.length === 0) {
    return { candidates: [], legacyAuth: false, emptyReason: "all_limited" };
  }

  if (input.workClass === "background") {
    const snaps = await latestSnapshots(deps.db);
    ordered = ordered.filter((r) => {
      if (r.kind !== "account") return true;
      const s = snaps.get(r.id);
      // Senza una lettura fresca l'account è ammesso.
      if (!s || !s.parseOk || now.getTime() - s.capturedAt.getTime() > MAX_SNAPSHOT_AGE_MS) {
        return true;
      }
      const weekly = parseWindow(s.weeklyRemaining);
      return weekly === null || weekly.percentUsed < deps.backgroundWeeklyThreshold;
    });
    if (ordered.length === 0) {
      return { candidates: [], legacyAuth: false, emptyReason: "all_over_threshold" };
    }
  }

  const candidates: ResolvedProvider[] = [];
  for (const r of ordered) {
    try {
      candidates.push({ id: r.id, kind: r.kind, secret: decrypt(r.secretEncrypted, deps.encryptionKey) });
    } catch {
      // Mai il payload nel log, solo id+label per la diagnosi.
      deps.log?.(
        `[stubwise-worker] provider AI '${r.label}' (${r.id}) scartato: segreto non decifrabile`,
      );
    }
  }
  // Tutti scartati alla decifratura: un problema di configurazione, non di quota (preflight D2).
  return {
    candidates,
    legacyAuth: false,
    emptyReason: candidates.length === 0 ? "no_usable_provider" : null,
  };
}

/** «Al limite fino a»: il più lontano fra il valore corrente e il nuovo (run paralleli). */
export async function markProviderLimited(db: Db, providerId: string, until: Date): Promise<void> {
  const iso = until.toISOString();
  await db
    .update(aiProviders)
    .set({
      limitedUntil: sql`greatest(coalesce(${aiProviders.limitedUntil}, ${iso}::timestamptz), ${iso}::timestamptz)`,
    })
    .where(eq(aiProviders.id, providerId));
}

/**
 * Marca `providerId` «al limite» fino all'ora letta da `text` (o dallo
 * snapshot, o +60'): la stessa regola di runWithProviders, per un run che non
 * passa da lì ma ha già scelto il suo account con selectProviders (l'
 * orientamento dei Docs, che apre un worktree e non si può ripetere a cuor
 * leggero sul candidato successivo).
 */
export async function markProviderLimitedFromText(
  deps: SelectDeps,
  providerId: string,
  text: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const mark = deps.markProviderLimitedFn ?? markProviderLimited;
  await mark(deps.db, providerId, await resetFor(deps, providerId, text, now));
}

/**
 * L'auth storica è finita al limite: se ne ricorda l'ora (dal testo, o +60')
 * nello stato in memoria condiviso, il più lontano fra il vecchio e il nuovo.
 * Senza uno snapshot (l'auth storica non ne ha) non c'è altro da cui derivare
 * un reset settimanale.
 */
export function markLegacyLimited(deps: SelectDeps, text: string): void {
  if (!deps.legacyLimit) return;
  const now = deps.now?.() ?? new Date();
  const until = limitResetAt(text, now) ?? new Date(now.getTime() + LIMIT_FALLBACK_MS);
  const current = deps.legacyLimit.until;
  if (!current || until.getTime() > current.getTime()) deps.legacyLimit.until = until;
  deps.log?.(
    `[stubwise-worker] auth storica del container al limite fino a ${deps.legacyLimit.until?.toISOString()}`,
  );
}

async function resetFor(
  deps: SelectDeps,
  providerId: string,
  text: string,
  now: Date,
): Promise<Date> {
  const fromText = limitResetAt(text, now);
  if (fromText) return fromText;
  // Una lettura degli snapshot fallita (o un db finto nei test dei chiamanti,
  // con selectProvidersFn/markProviderLimitedFn iniettati) non deve far
  // fallire il run: si ripiega sull'attesa fissa. Un reset dello snapshot
  // anche non fresco è accettato: è un limite superiore, e il poller d'uso
  // azzera limited_until appena torna margine.
  const snap = await latestSnapshots(deps.db)
    .then((m) => m.get(providerId))
    .catch((error: unknown) => {
      deps.log?.(
        `[stubwise-worker] lettura degli snapshot d'uso fallita per il provider ${providerId}: ${error instanceof Error ? error.message : String(error)}; attesa fissa`,
      );
      return undefined;
    });
  const future = (d: Date | null | undefined): d is Date => d != null && d.getTime() > now.getTime();
  // Dopo un limite SETTIMANALE il reset di sessione non serve: riaprirebbe
  // l'account per un run sprecato (preflight D18).
  const weekly = snap?.weeklyResetAt;
  if (/weekly/i.test(text) && future(weekly)) return weekly;
  const fromSnap = [snap?.sessionResetAt, snap?.weeklyResetAt].filter(future);
  if (fromSnap.length > 0) return new Date(Math.min(...fromSnap.map((d) => d.getTime())));
  return new Date(now.getTime() + LIMIT_FALLBACK_MS);
}

export async function runWithProviders<T>(
  deps: SelectDeps,
  input: SelectInput,
  attempt: (provider: ResolvedProvider | undefined) => Promise<T>,
  limitTextOf: (value: T) => string | null,
  hooks?: RunWithProvidersHooks,
): Promise<ProviderRun<T>> {
  const selection = await (deps.selectProvidersFn ?? selectProviders)(deps, input);
  if (selection.legacyAuth) {
    let value: T;
    try {
      value = await attempt(undefined);
    } catch (error) {
      if (!isLimitError(error)) throw error;
      const limitText = limitTextOfError(error);
      markLegacyLimited(deps, limitText);
      return { kind: "legacy_limited", limitText };
    }
    const limitText = limitTextOf(value);
    if (limitText === null) return { kind: "done", value, provider: undefined };
    markLegacyLimited(deps, limitText);
    return { kind: "legacy_limited", value, limitText };
  }
  if (selection.candidates.length === 0) {
    return { kind: "unavailable", reason: selection.emptyReason ?? "all_limited" };
  }
  const total = selection.candidates.length;
  for (const [i, provider] of selection.candidates.entries()) {
    let limitText: string | null;
    let value: T | undefined;
    try {
      value = await attempt(provider);
      limitText = limitTextOf(value);
    } catch (error) {
      if (!isLimitError(error)) throw error;
      limitText = limitTextOfError(error);
    }
    if (limitText === null) return { kind: "done", value: value as T, provider };
    await markProviderLimitedFromText(deps, provider.id, limitText);
    await hooks?.onLimited?.(provider, i + 1, total);
    deps.log?.(
      `[stubwise-worker] provider ${provider.id} al limite (${i + 1}/${total}): passo al successivo`,
    );
  }
  return { kind: "unavailable", reason: "all_limited_now" };
}

/**
 * Testo del limite di un errore già riconosciuto da isLimitError.
 * ProviderLimitError porta il testo vero in agentOutput: il message non ha né
 * marcatori né ora (preflight D6).
 */
function limitTextOfError(error: unknown): string {
  if (error instanceof ProviderLimitError) return error.agentOutput;
  return error instanceof Error ? error.message : String(error);
}

/** Testo del limite di un run del CLI (null se il run non è finito al limite). */
export const limitTextOfRun = (r: AgentRunResult): string | null =>
  isLimitError(r) ? r.output : null;

/** Motivi che dicono «aspetta che torni margine» (ripresa automatica) contro «configurazione da sistemare». */
export function isQuotaWait(reason: EmptyReason | "all_limited_now"): boolean {
  return reason === "all_limited" || reason === "all_over_threshold" || reason === "all_limited_now";
}
