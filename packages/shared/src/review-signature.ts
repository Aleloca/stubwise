/**
 * La FIRMA delle review di Stubwise sulle PR: `_— Stubwise PR Review · \`abc1234\`_`
 * in fondo al testo, col commit rivisto (7 caratteri dello sha).
 *
 * Generazione e riconoscimento stanno qui, uno accanto all'altro, così non
 * possono divergere: il worker la SCRIVE (`publishReview`,
 * `apps/worker/src/review/cycle.ts`) con {@link signReviewBody}, e chi legge i
 * commenti di una PR per decidere la RICONOSCE con
 * {@link hasStubwiseReviewSignature} — la fotografia dei commenti di una
 * correzione (`selectProviderFeedback`, `@stubwise/notifications`) e il
 * webhook "Request changes" (`handleChangesRequested`, server).
 *
 * Perché serve oltre agli «account propri»: quelli sono il principale e il
 * revisore EFFETTIVO di oggi, e una review pubblicata da un revisore che nel
 * frattempo non lo è più (predefinito cambiato) ha un autore che non risulta
 * proprio. La firma la riconosce qualunque sia l'autore.
 *
 * Il riconoscimento è STRETTO di proposito: la firma intera, su una riga sua,
 * ANCORATA in fondo al corpo (dopo sono ammessi solo spazi e righe vuote),
 * con uno sha esadecimale di esattamente 7 caratteri. Non una parola chiave:
 * un commento umano che nomina «Stubwise PR Review», o che cita la firma in
 * mezzo al testo, resta feedback.
 *
 * Il verso è SICURO: un umano che incolla la firma in fondo al proprio
 * commento si esclude da solo dalla fotografia — perde il suo feedback, ma non
 * può far ENTRARE niente. Un errore di riconoscimento può solo togliere, mai
 * aggiungere.
 */

/** La riga di firma per il commit `headSha` (ne usa i primi 7 caratteri). */
export function stubwiseReviewSignature(headSha: string): string {
  return `_— Stubwise PR Review · \`${headSha.slice(0, 7)}\`_`;
}

/** Il testo della review con la firma in fondo, separata da una riga vuota. */
export function signReviewBody(body: string, headSha: string): string {
  return `${body}\n\n${stubwiseReviewSignature(headSha)}`;
}

/**
 * La firma ancorata in fondo, su una riga sua. Gemella di
 * {@link stubwiseReviewSignature}: chi cambia l'una cambia l'altra, e
 * `review-signature.test.ts` genera la firma con la funzione VERA e la
 * riconosce.
 */
const SIGNATURE_AT_END = /(?:^|\n)_— Stubwise PR Review · `[0-9a-fA-F]{7}`_\s*$/;

/** Il corpo porta la firma delle review di Stubwise (vedi il docblock del modulo). */
export function hasStubwiseReviewSignature(body: string | null | undefined): boolean {
  return typeof body === "string" && SIGNATURE_AT_END.test(body);
}
