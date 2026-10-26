// La piegatura del testo per cercare, condivisa dal livello dati (Posta,
// Drive, Docs) e dalle pagine: senza maiuscole né accenti, così «caffe»
// trova «Caffè». Sta qui e non in `pages/chat/search.ts` perché il livello
// dati non dipende dalle pagine; quel modulo la ri-esporta.

/** Sotto, niente ricerca: «Type at least 2 characters». */
export const MIN_QUERY = 2;

/** Senza maiuscole né accenti: la stessa piegatura del livello dati. */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Le parole della ricerca, piegate. */
export const searchWords = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean);
