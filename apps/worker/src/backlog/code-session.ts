import { backlogChatMessages, backlogCodeSessions, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { and, eq, inArray, lt } from "drizzle-orm";
import { getContentLanguage } from "../settings.js";
import type { BacklogLogger } from "./poller.js";

/**
 * REGISTRO IN-PROCESSO delle sessioni di analisi sul codice del backlog (pattern
 * generationRegistry di docs/recursive/registry.ts).
 *
 * Ogni sessione `active` tiene UN worktree git READ-ONLY aperto pigramente al
 * PRIMO turno (a HEAD del default branch, via MirrorManager.openWorktree) e vivo
 * per i turni successivi: la `dir` non è persistita, l'unico modo per i turni
 * seguenti di ottenerla è questo handle in memoria. Insieme alla `dir` teniamo il
 * `cliSessionId` (l'id della sessione claude CLI per il `--resume`) e `lastUsed`
 * (per lo sweep TTL). Valido perché il worker è un SINGOLO processo (stessa
 * assunzione di deployment di MirrorManager e del serializzatore per-progetto).
 *
 * RIAVVIO DEL WORKER: il registro è in-memoria, quindi al riavvio TUTTI gli
 * handle sono persi. Il turno successivo NON trova la voce nel registro →
 * RI-BOOTSTRAP: riapre il worktree e avvia una NUOVA sessione CLI ri-innescata
 * con la storia recente dal DB (nessun `--resume`; il `cli_session_id` viene
 * riscritto). Trasparente: le sessioni NON bloccano il riavvio.
 *
 * CICLO DI VITA del worktree: rimosso quando la sessione si chiude — sweep TTL
 * (inattività), turno che trova la sessione non più active (DELETE/convert), o
 * shutdown del worker (best-effort). remove()/closeAll() sono idempotenti.
 */

/** Voce del registro: worktree aperto + stato della sessione CLI. */
export interface CodeSessionEntry {
  /** Id della sessione DB a cui il worktree appartiene: se la sessione viene
   * chiusa e RIAPERTA (nuovo id), un turno non deve riusare questo worktree né
   * fare `--resume` del vecchio cliSessionId (mischierebbe i contesti) → il
   * bootstrap rifà tutto da capo quando l'id non combacia. */
  sessionId: string;
  /** Repository su cui è aperto il worktree (deve combaciare con la sessione). */
  repositoryId: string;
  /** Working directory del worktree read-only (cwd dei run dell'agente). */
  dir: string;
  /** Id della sessione claude CLI per il `--resume`; null finché il primo turno
   * non lo assegna (o dopo un ri-bootstrap, prima del run). */
  cliSessionId: string | null;
  /** Epoch ms dell'ultimo uso (aggiornato a ogni turno); alimenta lo sweep. */
  lastUsed: number;
  /** Chiude il worktree (worktree + branch effimero + dir temporanea).
   * Idempotente: una doppia chiamata non fa danni. */
  remove: () => Promise<void>;
}

export interface CodeSessionRegistry {
  /** Voce registrata per la voce del backlog, o undefined (worktree non ancora
   * aperto o perso al riavvio). */
  get(itemId: string): CodeSessionEntry | undefined;
  /** Registra/sostituisce la voce (il chiamante ha appena aperto il worktree). */
  set(itemId: string, entry: CodeSessionEntry): void;
  /** Gli itemId con un worktree attualmente aperto in-process. */
  itemIds(): string[];
  /** Rimuove la voce e CHIUDE il suo worktree (best-effort). Idempotente:
   * itemId assente → no-op. */
  remove(itemId: string): Promise<void>;
  /** Chiude TUTTI i worktree e svuota il registro (shutdown). Best-effort:
   * un errore su uno non blocca gli altri. */
  closeAll(): Promise<void>;
}

/** Crea il registro in-processo delle sessioni di analisi sul codice. */
export function createCodeSessionRegistry(): CodeSessionRegistry {
  const entries = new Map<string, CodeSessionEntry>();

  return {
    get(itemId): CodeSessionEntry | undefined {
      return entries.get(itemId);
    },
    set(itemId, entry): void {
      entries.set(itemId, entry);
    },
    itemIds(): string[] {
      return [...entries.keys()];
    },
    async remove(itemId): Promise<void> {
      const entry = entries.get(itemId);
      if (!entry) return;
      // Rimuovi PRIMA dalla mappa (sincrono), poi chiudi: una seconda remove
      // concorrente non ritrova la voce e non ri-chiude lo stesso worktree.
      entries.delete(itemId);
      await entry.remove();
    },
    async closeAll(): Promise<void> {
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) {
        await entry.remove().catch(() => undefined);
      }
    },
  };
}

/** Dipendenze dello sweep TTL delle sessioni di analisi sul codice. */
export interface CodeSessionSweepDeps {
  db: Db;
  registry: CodeSessionRegistry;
  /** Minuti di inattività (last_activity_at) oltre cui una sessione active scade. */
  ttlMinutes: number;
  logger: BacklogLogger;
  /** "adesso" iniettabile nei test. Default new Date(). */
  now?: () => Date;
}

/**
 * SWEEP TTL: chiude le sessioni `active` inattive da più di `ttlMinutes`
 * (`last_activity_at` sotto la soglia) — status='closed' + closed_at + messaggio
 * `system` i18n — e riconcilia il registro rimuovendo i worktree delle sessioni
 * non più active (scadute qui, oppure chiuse da DELETE/convert senza che un
 * turno successivo le abbia ripulite). Best-effort: non lancia sui singoli
 * fallimenti (li logga), così un tick del poller non muore mai.
 */
export async function sweepCodeSessions(deps: CodeSessionSweepDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - deps.ttlMinutes * 60_000);

  // 1. Sessioni active scadute per inattività → closed + messaggio system.
  const expired = await deps.db
    .select({ itemId: backlogCodeSessions.itemId })
    .from(backlogCodeSessions)
    .where(and(eq(backlogCodeSessions.status, "active"), lt(backlogCodeSessions.lastActivityAt, cutoff)));
  if (expired.length > 0) {
    const lang = await getContentLanguage(deps.db);
    for (const { itemId } of expired) {
      try {
        await deps.db.transaction(async (tx) => {
          // Status-guarded: se un turno/DELETE l'ha già chiusa, 0 righe → skip.
          const [closed] = await tx
            .update(backlogCodeSessions)
            .set({ status: "closed", closedAt: now })
            .where(and(eq(backlogCodeSessions.itemId, itemId), eq(backlogCodeSessions.status, "active")))
            .returning({ id: backlogCodeSessions.id });
          if (!closed) return;
          await tx.insert(backlogChatMessages).values({
            itemId,
            role: "system",
            content: t(lang, "backlog.codeSessionExpired"),
          });
        });
      } catch (err) {
        deps.logger.error({ err, itemId }, "[backlog] sweep: chiusura sessione scaduta fallita");
      }
    }
  }

  // 2. Riconcilia il registro: rimuovi i worktree delle sessioni NON più active
  //    (scadute sopra, o chiuse da DELETE/convert senza un turno che le pulisse).
  const registryItemIds = deps.registry.itemIds();
  if (registryItemIds.length === 0) return;
  const active = await deps.db
    .select({ itemId: backlogCodeSessions.itemId })
    .from(backlogCodeSessions)
    .where(
      and(
        eq(backlogCodeSessions.status, "active"),
        inArray(backlogCodeSessions.itemId, registryItemIds),
      ),
    );
  const activeSet = new Set(active.map((a) => a.itemId));
  for (const itemId of registryItemIds) {
    if (!activeSet.has(itemId)) {
      await deps.registry.remove(itemId).catch((err: unknown) => {
        deps.logger.error({ err, itemId }, "[backlog] sweep: rimozione worktree orfano fallita");
      });
    }
  }
}

export interface StartCodeSessionSweeperOptions extends CodeSessionSweepDeps {
  /** Intervallo dello sweep in millisecondi. ≤ 0 = disabilitato. */
  intervalMs: number;
  signal: AbortSignal;
}

/**
 * Avvia lo sweep TTL su un proprio setInterval (tick non sovrapposti, pattern
 * startBacklogPoller). Allo shutdown (AbortSignal) chiude TUTTI i worktree
 * ancora aperti (best-effort) oltre a fermare il timer. intervalMs ≤ 0 =
 * disabilitato (ma il close-all allo shutdown resta registrato: se qualche
 * worktree fosse stato aperto va comunque chiuso). Ritorna uno stop idempotente.
 */
export function startCodeSessionSweeper(opts: StartCodeSessionSweeperOptions): () => void {
  // Chiudi i worktree aperti allo shutdown, SEMPRE (anche a interval disabilitato).
  opts.signal.addEventListener("abort", () => void opts.registry.closeAll(), { once: true });
  if (opts.intervalMs <= 0) {
    return () => {};
  }
  const { intervalMs, ...deps } = opts;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweepCodeSessions(deps);
    } catch (err) {
      deps.logger.error({ err }, "[backlog] sweep delle sessioni di analisi fallito");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  const stop = (): void => clearInterval(timer);
  opts.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
