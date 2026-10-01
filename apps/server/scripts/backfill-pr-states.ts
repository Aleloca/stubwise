import { createDb, gitAccounts, prCorrections, repositories, ticketRepositories, type Db } from "@stubwise/db";
import { getProvider, GitProviderError, type FetchLike, type GitProvider } from "@stubwise/git";
import { cancelOpenCorrections, decryptGitCredentials, markPrRowsClosed } from "@stubwise/notifications";
import { prNumberFromUrl, type GitProviderKind } from "@stubwise/shared";
import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { decodeEncryptionKey } from "./backfill-email-cc.js";
import { fetchWithRequestTimeout, PROVIDER_REQUEST_TIMEOUT_MS } from "./provider-fetch.js";

/**
 * ALLINEAMENTO UNA TANTUM dello stato delle PR già chiuse (ciclo di correzione
 * post-PR, G7, 1 ott 2026).
 *
 *   pnpm --filter @stubwise/server backfill:pr-states -- --dry-run
 *   pnpm --filter @stubwise/server backfill:pr-states
 *
 * In prod col `node` COMPILATO dentro il container (niente tsx né pnpm
 * nell'immagine, Postgres senza porte sull'host), DOPO il resync dei webhook
 * e come passo FACOLTATIVO:
 *
 *   docker compose exec server node dist/scripts/backfill-pr-states.js --dry-run
 *   docker compose exec server node dist/scripts/backfill-pr-states.js
 *
 * PERCHÉ. Fino a G3 il webhook di chiusura della PR lasciava
 * `ticket_repositories.pr_state = 'open'` quando il ticket non era più in
 * review. G3 lo corregge da lì in avanti, ma una PR già chiusa non manda più
 * eventi: quelle righe resterebbero `open` per sempre, comparirebbero nella
 * coda di rilascio e terrebbero acceso il bottone della correzione.
 *
 * COSA FA. Candidate: le righe `ticket_repositories` con `pr_state = 'open'` e
 * `pr_url` valorizzato. Il numero della PR è `pr_number`, o — per le righe
 * storiche senza — quello dell'URL (`prNumberFromUrl`, la regola unica). Per
 * ogni PR, IN SEQUENZA, chiede lo stato al provider
 * (`getPullRequestFinalState`) con le credenziali dell'account PRINCIPALE del
 * repository e un timeout di 15 s per richiesta. Se il provider dice
 * mergiata o rifiutata, percorre lo STESSO cammino del webhook (G3):
 * `markPrRowsClosed` (scrive SOLO `pr_state`, `merged` | `closed_unmerged`, e
 * solo sulle righe ancora `open`), poi `cancelOpenCorrections` coi ticket
 * appena chiusi in `lockTicketIds` — le correzioni `pending`/`queued` di quella
 * PR diventano `cancelled` e i loro job `queued`/`held` diventano `skipped`.
 * Se dice `open`, la riga è a posto: «ancora aperta».
 *
 * COSA NON FA. Non cambia lo stato di nessun ticket, non pubblica notifiche,
 * non inserisce job, non promuove le `pending` di altre PR. Quelle che
 * l'annullamento sblocca (il job della correzione annullata bloccava il
 * ticket) le prende il tick del worker: `promoteStalePendings` sceglie le
 * `pending` dei ticket su cui nessun job blocca più (`jobBlocksCorrection`), e
 * un job `skipped` non blocca — c'è un test che lo verifica.
 *
 * NON DEDUCE MAI UNO STATO. Errore del provider, timeout, PR non trovata (404),
 * risposta senza uno stato riconoscibile, credenziali non decifrabili o
 * account mancante, numero della PR non ricavabile: la riga NON si tocca e
 * finisce nel riepilogo come «non verificata», con la sola CATEGORIA del
 * motivo — mai il messaggio grezzo del provider (può contenere il corpo della
 * risposta), mai il token.
 *
 * `--dry-run`: nessuna scrittura, ma le chiamate al provider SÌ — è il modo
 * per contare quante righe si allineerebbero. Le credenziali si decifrano
 * comunque, così un account rotto emerge già in prova.
 *
 * IDEMPOTENTE: le righe allineate non sono più `open`, quindi al secondo
 * lancio non sono più candidate.
 *
 * EXIT CODE: 0 solo se OGNI riga è stata verificata (allineata o ancora
 * aperta); 1 se ne resta almeno una «non verificata», o se manca un env (lo
 * script esce PRIMA di toccare rete o DB). Il motivo: una riga non verificata
 * è esattamente il caso che lo script esiste per chiudere, e chi lo lancia a
 * mano deve vederlo dall'esito del comando, non solo da una riga del log —
 * rilanciarlo dopo (provider di nuovo raggiungibile, credenziali sistemate) è
 * innocuo.
 *
 * Servono `DATABASE_URL` e `ENCRYPTION_KEY` (base64, la stessa del server).
 */

/** Perché una riga non è stata verificata: una categoria, mai il messaggio grezzo. */
export type UnverifiedReason = "error" | "timeout" | "not_found" | "credentials" | "no_pr_number";

export interface BackfillPrStatesResult {
  /** Righe `open` con un `pr_url`. */
  candidates: number;
  /** Righe allineate (o, in `--dry-run`, da allineare) a `merged`. */
  merged: number;
  /** Righe allineate (o da allineare) a `closed_unmerged`. */
  closedUnmerged: number;
  /** Righe la cui PR il provider dice ancora aperta: già a posto. */
  stillOpen: number;
  /** Righe non toccate, per categoria del motivo. */
  unverified: Record<UnverifiedReason, number>;
  /**
   * Correzioni `pending`/`queued` delle PR da allineare: annullate (o, in
   * `--dry-run`, che verrebbero annullate). Contate subito prima
   * dell'annullamento.
   */
  correctionsCancelled: number;
}

/** Il provider per tipo, iniettabile: i test non parlano con la rete. */
export type ProviderFor = (kind: GitProviderKind) => Pick<GitProvider, "getPullRequestFinalState">;

export interface BackfillLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const defaultLogger: BackfillLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

/** Un timeout di `fetchWithRequestTimeout`, anche se incartato in un `cause`. */
function isTimeout(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { name?: unknown }).name === "TimeoutError") return true;
  }
  return false;
}

function classifyError(error: unknown): Exclude<UnverifiedReason, "credentials" | "no_pr_number"> {
  if (error instanceof GitProviderError && error.status === 404) return "not_found";
  if (isTimeout(error)) return "timeout";
  return "error";
}

export async function backfillPrStates(
  db: Db,
  opts: {
    dryRun: boolean;
    encryptionKey: Buffer;
    providerFor?: ProviderFor;
    logger?: BackfillLogger;
    /** Il `fetch` di base (iniettabile nei test); il timeout lo avvolge comunque. */
    fetchImpl?: FetchLike;
    requestTimeoutMs?: number;
  },
): Promise<BackfillPrStatesResult> {
  const providerFor = opts.providerFor ?? ((kind) => getProvider(kind));
  const logger = opts.logger ?? defaultLogger;
  const fetchImpl = fetchWithRequestTimeout(
    opts.fetchImpl ?? fetch,
    opts.requestTimeoutMs ?? PROVIDER_REQUEST_TIMEOUT_MS,
  );

  const rows = await db
    .select({
      id: ticketRepositories.id,
      repositoryId: ticketRepositories.repositoryId,
      prUrl: ticketRepositories.prUrl,
      prNumber: ticketRepositories.prNumber,
      slug: repositories.slug,
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(ticketRepositories)
    .innerJoin(repositories, eq(ticketRepositories.repositoryId, repositories.id))
    // Account PRINCIPALE del repository. Left join: un account mancante è
    // «non verificata: credentials», non una riga sparita dal conteggio.
    .leftJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    .where(and(eq(ticketRepositories.prState, "open"), isNotNull(ticketRepositories.prUrl)))
    .orderBy(asc(repositories.slug), asc(ticketRepositories.id));

  const result: BackfillPrStatesResult = {
    candidates: rows.length,
    merged: 0,
    closedUnmerged: 0,
    stillOpen: 0,
    unverified: { error: 0, timeout: 0, not_found: 0, credentials: 0, no_pr_number: 0 },
    correctionsCancelled: 0,
  };

  // Una domanda al provider per PR: più righe (ticket diversi) possono
  // puntare alla stessa PR, e `markPrRowsClosed` le allinea tutte insieme.
  const groups = new Map<string, { prNumber: number; rows: typeof rows }>();
  for (const row of rows) {
    const prNumber = row.prNumber ?? (row.prUrl === null ? null : prNumberFromUrl(row.prUrl));
    if (prNumber === null) {
      result.unverified.no_pr_number += 1;
      logger.warn(`[backfill-pr-states] ${row.slug}: riga ${row.id} senza numero di PR ricavabile, non verificata`);
      continue;
    }
    const key = `${row.repositoryId}#${prNumber}`;
    const group = groups.get(key) ?? { prNumber, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  for (const { prNumber, rows: group } of groups.values()) {
    const first = group[0]!;
    const label = `${first.slug}#${prNumber}`;
    // Decifrate ANCHE in --dry-run: un account rotto deve emergere in prova.
    const credentials =
      first.encryptedCredentials === null
        ? null
        : decryptGitCredentials(first.encryptedCredentials, opts.encryptionKey);
    if (!credentials) {
      result.unverified.credentials += group.length;
      logger.warn(`[backfill-pr-states] ${label}: non verificata (credentials)`);
      continue;
    }

    let state: "open" | "merged" | "closed_unmerged";
    try {
      state = await providerFor(first.provider).getPullRequestFinalState(
        { repoUrl: first.repoUrl, defaultBranch: first.defaultBranch, credentials },
        prNumber,
        { fetchImpl },
      );
    } catch (error) {
      // Mai uno stato dedotto da un errore: la riga resta com'è.
      const reason = classifyError(error);
      result.unverified[reason] += group.length;
      logger.warn(`[backfill-pr-states] ${label}: non verificata (${reason})`);
      continue;
    }

    if (state === "open") {
      result.stillOpen += group.length;
      continue;
    }

    const pr = { repositoryId: first.repositoryId, prNumber };
    const [open] = await db
      .select({ n: count() })
      .from(prCorrections)
      .where(
        and(
          eq(prCorrections.repositoryId, pr.repositoryId),
          eq(prCorrections.prNumber, pr.prNumber),
          inArray(prCorrections.status, ["pending", "queued"]),
        ),
      );
    const corrections = open?.n ?? 0;
    if (state === "merged") result.merged += group.length;
    else result.closedUnmerged += group.length;
    result.correctionsCancelled += corrections;

    if (opts.dryRun) {
      logger.info(
        `[backfill-pr-states] --dry-run: ${label} → ${state} (${group.length} righe, ${corrections} correzioni da annullare)`,
      );
      continue;
    }
    // Lo STESSO percorso del webhook di chiusura (G3): prima lo stato, poi
    // l'annullamento col lock dei ticket appena chiusi.
    const closedNow = await markPrRowsClosed(db, pr, state);
    await cancelOpenCorrections(db, pr, { lockTicketIds: [...closedNow] });
    logger.info(`[backfill-pr-states] ${label} → ${state} (${group.length} righe, ${corrections} correzioni annullate)`);
  }
  return result;
}

/** Il totale delle righe non verificate. */
export function unverifiedTotal(result: BackfillPrStatesResult): number {
  return Object.values(result.unverified).reduce((a, b) => a + b, 0);
}

/** Entry point CLI: solo env e `process.exit`. La logica è in `backfillPrStates`. */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKeyRaw = process.env.ENCRYPTION_KEY;
  if (!databaseUrl || !encryptionKeyRaw) {
    console.error("[backfill-pr-states] servono DATABASE_URL ed ENCRYPTION_KEY");
    process.exit(1);
  }
  let encryptionKey: Buffer;
  try {
    encryptionKey = decodeEncryptionKey(encryptionKeyRaw);
  } catch (error) {
    console.error(`[backfill-pr-states] ${(error as Error).message}`);
    process.exit(1);
  }
  const handle = createDb(databaseUrl);
  try {
    const r = await backfillPrStates(handle.db, { dryRun, encryptionKey });
    const u = r.unverified;
    console.log(
      `[backfill-pr-states] ${dryRun ? "--dry-run: " : ""}${r.candidates} candidate; ` +
        `${dryRun ? "da allineare" : "allineate"}: ${r.merged} merged, ${r.closedUnmerged} closed_unmerged; ` +
        `${r.stillOpen} ancora aperte; non verificate: ${unverifiedTotal(r)} ` +
        `(errore ${u.error}, timeout ${u.timeout}, non trovata ${u.not_found}, credenziali ${u.credentials}, senza numero ${u.no_pr_number}); ` +
        `correzioni ${dryRun ? "che verrebbero annullate" : "annullate"}: ${r.correctionsCancelled}`,
    );
    if (unverifiedTotal(r) > 0) process.exitCode = 1;
  } finally {
    await handle.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
