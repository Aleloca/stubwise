import { instanceSettings, type Db } from "@stubwise/db";
import type { Language } from "@stubwise/shared";
import { eq } from "drizzle-orm";

/**
 * Impostazioni globali dell'istanza usate dal worker. Per ora solo la lingua
 * dei contenuti generati dall'AI (commenti sul ticket, report della PR, prompt
 * passati ai modelli), distinta dalla lingua di UI del singolo utente.
 */

/**
 * Legge `instance_settings.content_language` (riga singleton id=1) e ritorna la
 * lingua dei contenuti generati. Fallback `'en'` se la riga manca (istanza non
 * ancora seedata): un default sensato che non fa mai fallire il job.
 *
 * Da risolvere UNA VOLTA per job e passare giù ai builder dei prompt e ai
 * `t(lang, ...)` dei commenti, così tutta la pipeline di un job parla la stessa
 * lingua anche se l'impostazione cambia a metà.
 */
export async function getContentLanguage(db: Db): Promise<Language> {
  const [row] = await db
    .select({ contentLanguage: instanceSettings.contentLanguage })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, 1));
  return row?.contentLanguage ?? "en";
}
