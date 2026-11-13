// I link verso Google che l'app apre (review F5a, 5): solo un Google Doc per
// «Open the transcript», e solo un indirizzo di Gmail o di Google Docs per
// `openOnGoogle`. Un link che arriva dal server con un altro host non si apre:
// la difesa vale per la build app e per il web.

const GOOGLE_DOC = /^https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:[/?#].*)?$/;
const GOOGLE_OPENABLE = /^https:\/\/(?:mail|docs)\.google\.com\//;

/** Il link se è un Google Doc, altrimenti `null`. */
export const googleDocUrl = (url: string | null | undefined): string | null =>
  url && GOOGLE_DOC.test(url) ? url : null;

/** Un indirizzo di Gmail o di Google Docs. */
export const isOpenableOnGoogle = (url: string): boolean => GOOGLE_OPENABLE.test(url);
