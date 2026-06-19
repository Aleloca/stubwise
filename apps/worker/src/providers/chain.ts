import { aiProviders, decrypt, type Db } from "@stubwise/db";
import { asc, eq } from "drizzle-orm";

/**
 * Credenziale di un provider AI risolta (decifrata) e pronta per l'iniezione
 * nell'env del CLI claude. `kind` decide COME viene iniettata (vedi
 * buildAgentEnv in agent/claude-cli.ts):
 *  - "api_key" → ANTHROPIC_API_KEY = secret;
 *  - "account" → CLAUDE_CODE_OAUTH_TOKEN = secret.
 * `secret` è il segreto in CHIARO: non va MAI loggato.
 */
export interface ResolvedProvider {
  /** id della riga ai_providers, registrato su ai_jobs.provider_id. */
  id: string;
  kind: "api_key" | "account";
  /** Segreto decifrato (chiave API o token OAuth). Mai loggare. */
  secret: string;
}

/**
 * Carica la catena di provider AI abilitati, in ordine di `position` crescente,
 * decifrando il `secret_encrypted` di ciascuno. È l'ordine di failover usato
 * dal worker: il primo della lista è la credenziale preferita.
 *
 * Robustezza: una voce il cui segreto non si decifra (chiave sbagliata, payload
 * manomesso) viene SCARTATA con un warning — NON blocca le altre. Così una
 * singola credenziale corrotta non mette fuori uso l'intera catena. Il warning
 * nomina id e label per la diagnosi ma NON tocca mai il segreto.
 */
export async function loadProviderChain(
  db: Db,
  encryptionKey: Buffer,
): Promise<ResolvedProvider[]> {
  const rows = await db
    .select({
      id: aiProviders.id,
      kind: aiProviders.kind,
      label: aiProviders.label,
      secretEncrypted: aiProviders.secretEncrypted,
    })
    .from(aiProviders)
    .where(eq(aiProviders.enabled, true))
    .orderBy(asc(aiProviders.position));

  const chain: ResolvedProvider[] = [];
  for (const row of rows) {
    let secret: string;
    try {
      secret = decrypt(row.secretEncrypted, encryptionKey);
    } catch {
      // Segreto non decifrabile: scartiamo questa voce ma proseguiamo. Mai il
      // payload nel log, solo id+label per la diagnosi.
      console.error(
        `[stubwise-worker] provider AI '${row.label}' (${row.id}) scartato: segreto non decifrabile (ENCRYPTION_KEY errata o payload non valido)`,
      );
      continue;
    }
    chain.push({ id: row.id, kind: row.kind, secret });
  }
  return chain;
}
