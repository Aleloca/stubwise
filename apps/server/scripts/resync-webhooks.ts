import { createDb, decrypt, gitAccounts, repositories, type Db } from "@stubwise/db";
import { getProvider, GitProviderError, type GitProvider } from "@stubwise/git";
import type { GitProviderKind } from "@stubwise/shared";
import { asc, eq, ne } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { decodeEncryptionKey } from "./backfill-email-cc.js";

/**
 * RIALLINEAMENTO UNA TANTUM dei webhook git (ciclo di correzione post-PR,
 * 30 set 2026, design §13).
 *
 *   pnpm --filter @stubwise/server resync:webhooks -- --dry-run
 *   pnpm --filter @stubwise/server resync:webhooks
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
 * Tocca SOLO il provider e `repositories.webhook_configured_at` (come la rotta
 * `/configure-webhook`). Non fa partire nessun job.
 */

export interface ResyncWebhooksResult {
  /** Repository con un segreto webhook (gli altri non sono verificabili e si saltano). */
  candidates: number;
  created: number;
  updated: number;
  failed: number;
}

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
    encryptionKey: Buffer;
    publicUrl: string;
    providerFor?: ProviderFor;
    logger?: ResyncLogger;
  },
): Promise<ResyncWebhooksResult> {
  const providerFor = opts.providerFor ?? ((kind) => getProvider(kind));
  const logger = opts.logger ?? defaultLogger;
  const base = opts.publicUrl.replace(/\/+$/, "");

  const rows = await db
    .select({
      id: repositories.id,
      slug: repositories.slug,
      provider: repositories.provider,
      repoUrl: repositories.repoUrl,
      defaultBranch: repositories.defaultBranch,
      webhookSecret: repositories.webhookSecret,
      encryptedCredentials: gitAccounts.encryptedCredentials,
    })
    .from(repositories)
    .innerJoin(gitAccounts, eq(repositories.gitAccountId, gitAccounts.id))
    // Segreto vuoto = repository legacy: un webhook che non si può verificare
    // non va registrato (la rotta lo rifiuterebbe comunque con 401).
    .where(ne(repositories.webhookSecret, ""))
    .orderBy(asc(repositories.slug));

  const result: ResyncWebhooksResult = { candidates: rows.length, created: 0, updated: 0, failed: 0 };
  for (const row of rows) {
    const url = `${base}/webhooks/git/${row.slug}`;
    if (opts.dryRun) {
      logger.info(`[resync-webhooks] --dry-run: ${row.slug} (${row.provider}) → ${url}`);
      continue;
    }
    const credentials = decryptCredentials(row.encryptedCredentials, opts.encryptionKey);
    if (!credentials) {
      logger.warn(`[resync-webhooks] ${row.slug}: credenziali dell'account non decifrabili, saltato`);
      result.failed += 1;
      continue;
    }
    try {
      const outcome = await providerFor(row.provider).ensureWebhook(
        { repoUrl: row.repoUrl, defaultBranch: row.defaultBranch, credentials },
        { url, secret: row.webhookSecret },
        { fetchImpl: fetch },
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
    const result = await resyncWebhooks(handle.db, { dryRun, encryptionKey, publicUrl });
    console.log(
      dryRun
        ? `[resync-webhooks] --dry-run: ${result.candidates} repository da riallineare (nessuna chiamata)`
        : `[resync-webhooks] ${result.updated} aggiornati, ${result.created} creati, ${result.failed} falliti, su ${result.candidates}`,
    );
    // Un fallimento non ferma gli altri, ma l'esito del comando lo dice.
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await handle.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
