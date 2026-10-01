import { createDb, decrypt, gitAccounts, repositories, type Db } from "@stubwise/db";
import { getProvider, GitProviderError, type FetchLike, type GitProvider } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { asc, eq, ne } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { decodeEncryptionKey } from "./backfill-email-cc.js";
import { fetchWithRequestTimeout, PROVIDER_REQUEST_TIMEOUT_MS } from "./provider-fetch.js";

/**
 * RIALLINEAMENTO UNA TANTUM dei webhook git (ciclo di correzione post-PR,
 * 30 set 2026, design §13).
 *
 *   pnpm --filter @stubwise/server resync:webhooks -- --dry-run
 *   pnpm --filter @stubwise/server resync:webhooks
 *   pnpm --filter @stubwise/server resync:webhooks -- --include-unconfigured
 *
 * In prod col `node` COMPILATO dentro il container (niente tsx né pnpm
 * nell'immagine, Postgres senza porte sull'host):
 *
 *   docker compose exec server node dist/scripts/resync-webhooks.js --dry-run
 *   docker compose exec server node dist/scripts/resync-webhooks.js
 *
 * I webhook registrati prima di questa fase sono iscritti a merge/rifiuto,
 * apertura/aggiornamento e push, ma non a "Request changes" (Bitbucket
 * `pullrequest:changes_request_created`, GitHub `pull_request_review`): senza
 * questo passo il ciclo manuale dalla piattaforma non parte. `ensureWebhook`
 * è idempotente (aggiorna quello con lo stesso URL), quindi rilanciarlo è
 * innocuo.
 *
 * Servono `DATABASE_URL`, `ENCRYPTION_KEY` (base64, la stessa del server: le
 * credenziali degli account sono cifrate) e `PUBLIC_URL` (l'URL registrato
 * sul provider è `${PUBLIC_URL}/webhooks/git/<slug>`, come in
 * `/configure-webhook`).
 *
 * RIALLINEA, NON CREA. Di default prende SOLO i repository il cui webhook è
 * già stato configurato (`webhook_configured_at IS NOT NULL`). Un hook con lo
 * stesso URL viene riscritto PER INTERO, esattamente come fa «Configura
 * webhook» dalla UI: torna `active: true` se qualcuno l'aveva disattivato, e
 * `events` torna all'elenco del ciclo di correzione (B12). Chi lo aveva
 * spento a mano sul provider se lo ritrova acceso: è il prezzo
 * dell'idempotenza, ed è lo stesso del bottone.
 * Lo script non fa partire job da sé, ma CREARE un hook dove non c'era fa
 * arrivare eventi (push, PR aperte/aggiornate, "Request changes") che possono
 * farne partire — review, fix tracciati, correzioni. Per questo i repository
 * mai configurati entrano solo col flag esplicito `--include-unconfigured`, e
 * in `--dry-run` sono elencati A PARTE fra quelli che verrebbero creati
 * (stima: senza rete non si sa se sul provider un hook esista già).
 *
 * `--dry-run` non chiama il provider ma DECIFRA comunque le credenziali: un
 * account non decifrabile (chiave sbagliata, blob corrotto) emerge già in
 * prova, come fallimento.
 *
 * Ogni richiesta al provider ha un timeout di 15 s: un provider che non
 * risponde fa fallire QUEL repository (exit code 1 alla fine) e lo script
 * passa al successivo.
 *
 * Tocca SOLO il provider e `repositories.webhook_configured_at` (come la rotta
 * `/configure-webhook`).
 */

export interface ResyncWebhooksResult {
  /** Repository con un segreto webhook (gli altri non sono verificabili e si saltano). */
  candidates: number;
  created: number;
  updated: number;
  failed: number;
  /**
   * Slug dei repository MAI configurati che il run prende (solo con
   * `includeUnconfigured`): in `--dry-run` sono quelli che verrebbero creati.
   */
  toCreate: string[];
  /** Repository mai configurati lasciati fuori perché manca `--include-unconfigured`. */
  skippedUnconfigured: number;
}

/** Timeout di default di ogni richiesta al provider (la regola comune degli script). */
export const RESYNC_REQUEST_TIMEOUT_MS = PROVIDER_REQUEST_TIMEOUT_MS;

// Estratto in `provider-fetch.ts` (lo usa anche `backfill-pr-states`):
// ri-esportato qui perché i chiamanti esistenti non cambino import.
export { fetchWithRequestTimeout };

/** Il provider per tipo, iniettabile: i test non parlano con la rete. */
export type ProviderFor = (kind: GitProviderKind) => Pick<GitProvider, "ensureWebhook">;

export interface ResyncLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const defaultLogger: ResyncLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

interface Credentials {
  username?: string;
  email?: string;
  token: string;
}

/** `null` se il blob non si decifra (chiave sbagliata o account corrotto). */
function decryptCredentials(encrypted: string, key: Buffer): Credentials | null {
  try {
    const parsed = JSON.parse(decrypt(encrypted, key)) as Partial<Credentials>;
    return typeof parsed.token === "string" && parsed.token !== "" ? (parsed as Credentials) : null;
  } catch {
    return null;
  }
}

export async function resyncWebhooks(
  db: Db,
  opts: {
    dryRun: boolean;
    /** Prende anche i repository mai configurati (CREA un hook): `--include-unconfigured`. */
    includeUnconfigured?: boolean;
    encryptionKey: Buffer;
    publicUrl: string;
    providerFor?: ProviderFor;
    logger?: ResyncLogger;
    /** Il `fetch` di base (iniettabile nei test); il timeout lo avvolge comunque. */
    fetchImpl?: FetchLike;
    requestTimeoutMs?: number;
  },
): Promise<ResyncWebhooksResult> {
  const providerFor = opts.providerFor ?? ((kind) => getProvider(kind));
  const logger = opts.logger ?? defaultLogger;
  const base = opts.publicUrl.replace(/\/+$/, "");
  const fetchImpl = fetchWithRequestTimeout(
    opts.fetchImpl ?? fetch,
    opts.requestTimeoutMs ?? RESYNC_REQUEST_TIMEOUT_MS,
  );

  const rows = await db
    .select({
      id: repositories.id,
      slug: repositories.slug,
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      webhookSecret: repositories.webhookSecret,
      webhookConfiguredAt: repositories.webhookConfiguredAt,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    // Segreto vuoto = repository legacy: un webhook che non si può verificare
    // non va registrato (la rotta lo rifiuterebbe comunque con 401).
    .where(ne(repositories.webhookSecret, ""))
    .orderBy(asc(repositories.slug));

  // Riallinea, non crea: i mai configurati solo col flag esplicito.
  const selected = rows.filter((r) => r.webhookConfiguredAt !== null || opts.includeUnconfigured === true);
  const result: ResyncWebhooksResult = {
    candidates: selected.length,
    created: 0,
    updated: 0,
    failed: 0,
    toCreate: selected.filter((r) => r.webhookConfiguredAt === null).map((r) => r.slug),
    skippedUnconfigured: rows.length - selected.length,
  };
  for (const row of selected) {
    const url = `${base}/webhooks/git/${row.slug}`;
    // Decifrate ANCHE in --dry-run: un account rotto deve emergere in prova.
    const credentials = decryptCredentials(row.encryptedCredentials, opts.encryptionKey);
    if (!credentials) {
      logger.warn(`[resync-webhooks] ${row.slug}: credenziali dell'account non decifrabili, saltato`);
      result.failed += 1;
      continue;
    }
    if (opts.dryRun) {
      const verb = row.webhookConfiguredAt === null ? "da CREARE" : "da riallineare";
      logger.info(`[resync-webhooks] --dry-run: ${row.slug} (${row.provider}) ${verb} → ${url}`);
      continue;
    }
    try {
      const outcome = await providerFor(row.provider).ensureWebhook(
        { repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, credentials },
        { url, secret: row.webhookSecret },
        { fetchImpl },
      );
      if (outcome.created) result.created += 1;
      else result.updated += 1;
      await db
        .update(repositories)
        .set({ webhookConfiguredAt: new Date() })
        .where(eq(repositories.id, row.id));
      logger.info(`[resync-webhooks] ${row.slug}: ${outcome.detail}`);
    } catch (error) {
      result.failed += 1;
      const message = error instanceof GitProviderError ? error.message : String(error);
      logger.warn(`[resync-webhooks] ${row.slug}: ${message}`);
    }
  }
  return result;
}

/** Entry point CLI: solo env e `process.exit`. La logica è in `resyncWebhooks`. */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const includeUnconfigured = process.argv.includes("--include-unconfigured");
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKeyRaw = process.env.ENCRYPTION_KEY;
  const publicUrl = process.env.PUBLIC_URL;
  if (!databaseUrl || !encryptionKeyRaw || !publicUrl) {
    console.error("[resync-webhooks] servono DATABASE_URL, ENCRYPTION_KEY e PUBLIC_URL");
    process.exit(1);
  }
  let encryptionKey: Buffer;
  try {
    encryptionKey = decodeEncryptionKey(encryptionKeyRaw);
  } catch (error) {
    console.error(`[resync-webhooks] ${(error as Error).message}`);
    process.exit(1);
  }
  const handle = createDb(databaseUrl);
  try {
    const result = await resyncWebhooks(handle.db, { dryRun, includeUnconfigured, encryptionKey, publicUrl });
    console.log(
      dryRun
        ? `[resync-webhooks] --dry-run: ${result.candidates - result.toCreate.length} da riallineare, ${result.toCreate.length} da creare, ${result.failed} con credenziali non decifrabili (nessuna chiamata)`
        : `[resync-webhooks] ${result.updated} aggiornati, ${result.created} creati, ${result.failed} falliti, su ${result.candidates}`,
    );
    if (result.toCreate.length > 0) {
      console.log(`[resync-webhooks] verrebbero CREATI (mai configurati): ${result.toCreate.join(", ")}`);
    }
    if (result.skippedUnconfigured > 0) {
      console.log(
        `[resync-webhooks] ${result.skippedUnconfigured} repository mai configurati esclusi (servirebbe --include-unconfigured)`,
      );
    }
    // Un fallimento non ferma gli altri, ma l'esito del comando lo dice.
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await handle.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
