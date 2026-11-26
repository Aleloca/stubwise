import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Dà il codice `<PRJ>-D<n>` (0142) alle coppie (repository, slug) che non ce
 * l'hanno, in una transazione BREVE e sua. Il trigger su `doc_pages` lo fa
 * comunque per ogni pagina nuova, ma sotto un lock per progetto tenuto fino
 * alla fine della transazione che inserisce: per una generazione o un giro
 * notturno (embedding compresi, minuti) quel lock terrebbe in fila ogni pagina
 * manuale nuova dello stesso progetto. Gli scrittori LUNGHI chiamano questa
 * funzione prima della loro transazione, col `Db` e mai con un `tx`: il
 * trigger trova i codici e non prende il lock. Un codice dato a uno slug la
 * cui transazione poi fallisce resta lì (non si riusa, e alla prossima
 * generazione con quello slug torna buono).
 */
export async function ensureDocPageCodes(db: Db, repositoryId: string, slugs: readonly string[]): Promise<void> {
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select stubwise_ensure_doc_page_codes(${repositoryId}::uuid, ${sql.raw("ARRAY[")}${sql.join(
      unique.map((s) => sql`${s}`),
      sql`, `,
    )}${sql.raw("]::text[]")})`);
  });
}
