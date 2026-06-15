import { instanceSettings, type Db } from "@stubwise/db";
import type { Language } from "@stubwise/shared";
import { eq } from "drizzle-orm";

/**
 * Impostazioni globali dell'istanza usate dal server. Per ora solo la lingua
 * dei contenuti generati dal backend (es. i commenti di sistema postati sul
 * ticket dal webhook git), distinta dalla lingua di UI del singolo utente.
 *
 * Speculare a `apps/worker/src/settings.ts`: i due ambienti leggono lo stesso
 * singleton `instance_settings` (id=1) per parlare la stessa lingua.
 */

/**
 * Legge `instance_settings.content_language` (riga singleton id=1) e ritorna la
 * lingua dei contenuti generati. Fallback `'en'` se la riga manca (istanza non
 * ancora seedata): un default sensato che non fa mai fallire la richiesta.
 */
export async function getContentLanguage(db: Db): Promise<Language> {
  const [row] = await db
    .select({ contentLanguage: instanceSettings.contentLanguage })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return row?.contentLanguage ?? "en";
}
