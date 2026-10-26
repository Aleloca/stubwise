import { gate, storeGeneration } from "./store";

// Il cancello di una scrittura e i suoi errori, condivisi da Posta e
// Calendario (area 6): `not_found` per ciò che chi agisce non vede (R-G5),
// `forbidden` per ciò che vede ma non può fare, `invalid: <cosa>` per un
// input sbagliato.

export const notFound = () => new Error("not_found");
export const forbidden = () => new Error("forbidden");
export const invalid = (what: string) => new Error(`invalid: ${what}`);

/**
 * Il cancello di una scrittura: chi agisce, letto quando parte. Un
 * ripristino (`resetApi`) durante l'attesa la ferma prima che scriva.
 */
export async function writer(fnName: Parameters<typeof gate>[0]): Promise<string> {
  const gen = storeGeneration();
  const me = await gate(fnName);
  if (gen !== storeGeneration()) throw new Error("reset");
  return me;
}
