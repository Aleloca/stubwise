import {
  createDb,
  emailMessages,
  googleAccounts,
  type Db,
} from "@stubwise/db";
import { getMessageMetadata, GoogleApiError, refreshAccessToken } from "@stubwise/google";
import { loadGoogleAccountCredentials } from "@stubwise/google/credentials";
import { parseAddressList } from "@stubwise/notifications";
import { and, eq, isNull } from "drizzle-orm";
import { pathToFileURL } from "node:url";

/**
 * RECUPERO UNA TANTUM di chi è in COPIA sui messaggi storici (16 set 2026,
 * design §4.1).
 *
 *   pnpm --filter @stubwise/server backfill:email-cc -- --dry-run
 *   pnpm --filter @stubwise/server backfill:email-cc
 *
 * In prod si lancia col `node` COMPILATO dentro il container — l'immagine è un
 * `pnpm deploy --prod` e non contiene né `tsx` né pnpm, e il Postgres del
 * compose non pubblica porte sull'host:
 *
 *   docker compose exec server node dist/scripts/backfill-email-cc.js --dry-run
 *   docker compose exec server node dist/scripts/backfill-email-cc.js
 *
 * Il `cc` non è ricostruibile dal database: sta solo su Gmail. Senza questo
 * recupero il campo appena chiesto sarebbe quasi invisibile per settimane —
 * solo i messaggi nuovi ce l'avrebbero — proprio durante i test.
 *
 * NON è una migrazione, ed è una scelta (stessa di
 * `backfill-ticket-done-events.ts`): parla con una API ESTERNA, quindi non può
 * stare dentro la transazione d'avvio del server, e va lanciato quando si
 * vuole.
 *
 * ## IDEMPOTENTE davvero, e si regge sul `null`
 *
 * La condizione di ripresa è `cc_addresses IS NULL`, cioè «riga scritta prima
 * della colonna, non lo sappiamo» — distinta da `{}`, «lo sappiamo, non c'era
 * nessuno in copia». Una seconda esecuzione non chiama Google **nemmeno una
 * volta**: è la ragione per cui la colonna è nullable e non
 * `not null default '{}'` (vedi il docblock in `packages/db/src/schema.ts`).
 *
 * ## I TRE PALETTI, che valgono più della funzionalità
 *
 * 1. **Tocca SOLO `cc_addresses`.** Mai `text_excerpt` (è ciò che la
 *    CLASSIFICAZIONE ha letto), mai `status`, mai `outcome`, mai una riga di
 *    `email_proposals`. Una proposta aperta non deve accorgersi che questo
 *    script è passato.
 * 2. **Un 404 non ferma il resto.** Un messaggio cancellato da Gmail è il caso
 *    NORMALE su dati vecchi, non un errore: quella riga resta `null`, si logga,
 *    e si prosegue. (Resterà `null`, quindi un lancio futuro riproverà: è il
 *    prezzo di non poter distinguere «cancellato» da «mai guardato» senza una
 *    terza colonna che non vale la pena avere.)
 * 3. **Non fa partire NIENTE.** Nessun job, nessuna classificazione, nessuna
 *    notifica. Stessa dottrina del percorso `auto` del calendario
 *    (`calendar-auto.ts`): uno script che tocca la posta non avvia lavoro.
 */

/** Esito di un giro di recupero. */
export interface BackfillEmailCcResult {
  /** Righe con `cc_addresses is null` trovate. */
  candidates: number;
  /** Righe effettivamente aggiornate (0 con `--dry-run`). */
  updated: number;
  /** Righe saltate perché il messaggio non esiste più su Gmail, o la casella non è usabile. */
  skipped: number;
}

/** Le sole funzioni Google usate — iniettabili, così i test non parlano con la rete. */
export interface BackfillGoogleClient {
  refreshAccessToken: typeof refreshAccessToken;
  getMessageMetadata: typeof getMessageMetadata;
}

const defaultGoogleClient: BackfillGoogleClient = { refreshAccessToken, getMessageMetadata };

/** Log minimale, iniettabile: i test contano le righe invece di sporcare l'output. */
export interface BackfillLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

const defaultLogger: BackfillLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};

export async function backfillEmailCc(
  db: Db,
  opts: {
    dryRun: boolean;
    encryptionKey: Buffer;
    google?: BackfillGoogleClient;
    logger?: BackfillLogger;
  },
): Promise<BackfillEmailCcResult> {
  const google = opts.google ?? defaultGoogleClient;
  const logger = opts.logger ?? defaultLogger;

  // Raggruppate per CASELLA: un `refreshAccessToken` per casella, non uno per
  // messaggio. Le 163 righe di produzione stanno su poche caselle.
  const rows = await db
    .select({
      id: emailMessages.id,
      accountId: emailMessages.accountId,
      gmailMessageId: emailMessages.gmailMessageId,
    })
    .from(emailMessages)
    .where(isNull(emailMessages.ccAddresses))
    .orderBy(emailMessages.accountId, emailMessages.id);

  if (rows.length === 0 || opts.dryRun) {
    return { candidates: rows.length, updated: 0, skipped: 0 };
  }

  const byAccount = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byAccount.get(row.accountId) ?? [];
    bucket.push(row);
    byAccount.set(row.accountId, bucket);
  }

  let updated = 0;
  let skipped = 0;

  for (const [accountId, messages] of byAccount) {
    const credentials = await loadGoogleAccountCredentials(db, opts.encryptionKey, accountId);
    if (!credentials) {
      // Una casella scollegata o con credenziali non decifrabili non è un
      // errore da fermare tutto: le sue righe restano `null`.
      logger.warn(`[backfill-cc] casella ${accountId} non usabile: ${messages.length} righe saltate`);
      skipped += messages.length;
      continue;
    }

    let accessToken: string;
    try {
      const tokens = await google.refreshAccessToken({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        refreshToken: credentials.refreshToken,
      });
      accessToken = tokens.accessToken;
    } catch (err) {
      logger.warn(
        `[backfill-cc] token non rinnovabile per la casella ${accountId} (${String(err)}): ${messages.length} righe saltate`,
      );
      skipped += messages.length;
      continue;
    }

    const [account] = await db
      .select({ email: googleAccounts.email })
      .from(googleAccounts)
      .where(eq(googleAccounts.id, accountId));

    for (const message of messages) {
      let cc: string[];
      try {
        // `format=metadata`, la STESSA chiamata del poller: `Cc` è già fra gli
        // header di default, nessuna richiesta speciale.
        const full = await google.getMessageMetadata({
          accessToken,
          id: message.gmailMessageId,
        });
        cc = parseAddressList(full.headers["cc"]);
      } catch (err) {
        // Un messaggio cancellato da Gmail è il caso NORMALE su dati vecchi.
        const gone = err instanceof GoogleApiError && err.status === 404;
        logger.warn(
          gone
            ? `[backfill-cc] messaggio ${message.gmailMessageId} non più su Gmail (${account?.email ?? accountId}): saltato`
            : `[backfill-cc] lettura fallita per ${message.gmailMessageId}: ${String(err)}`,
        );
        skipped += 1;
        continue;
      }

      // ⚠️ SOLO `cc_addresses`. Nessun altro campo di `email_messages`, e
      // nessuna riga di `email_proposals`: una proposta aperta non deve
      // accorgersi che questo script è passato. La guardia `is null` nel
      // `where` fa anche da protezione contro una corsa col poller, che nel
      // frattempo potrebbe aver riscritto la riga con un `cc` vero.
      await db
        .update(emailMessages)
        .set({ ccAddresses: cc })
        .where(and(eq(emailMessages.id, message.id), isNull(emailMessages.ccAddresses)));
      updated += 1;
    }
  }

  return { candidates: rows.length, updated, skipped };
}

/**
 * Entry point CLI. Separato dalla funzione così i test esercitano la logica su
 * un Postgres di test con un client Google finto, senza toccare env né
 * `process.exit`.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const databaseUrl = process.env.DATABASE_URL;
  const encryptionKeyHex = process.env.ENCRYPTION_KEY;
  if (!databaseUrl) {
    console.error("[backfill-cc] DATABASE_URL non impostata");
    process.exit(1);
  }
  if (!encryptionKeyHex) {
    console.error("[backfill-cc] ENCRYPTION_KEY non impostata (serve a decifrare i refresh token)");
    process.exit(1);
  }
  const handle = createDb(databaseUrl);
  try {
    const result = await backfillEmailCc(handle.db, {
      dryRun,
      encryptionKey: Buffer.from(encryptionKeyHex, "hex"),
    });
    console.log(
      dryRun
        ? `[backfill-cc] --dry-run: ${result.candidates} messaggi senza copia nota (nessuna scrittura, nessuna chiamata a Google)`
        : `[backfill-cc] ${result.updated} aggiornati, ${result.skipped} saltati, su ${result.candidates} candidati`,
    );
  } finally {
    await handle.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
