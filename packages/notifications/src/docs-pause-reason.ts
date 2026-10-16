/**
 * PERCHÉ una generazione Docs è in pausa (16 ott 2026, follow-up F2b).
 *
 * `doc_generations.pause_reason` e il campo `reason` dell'evento
 * `docs.limit_paused` portano un CODICE MACCHINA stabile, mai una frase: il
 * resume poller lo confronta per decidere come riprendere, il payload
 * `generic` dei webhook lo esporta così com'è, e la prosa che leggono le
 * persone (inbox, push, Slack) la produce il catalogo i18n al momento della
 * resa. Prima la reason era una frase italiana confrontata per uguaglianza:
 * ritoccarne il testo cambiava cosa il poller riconosceva, e la frase
 * nominava perfino una variabile d'ambiente.
 *
 * - `provider_limit`: gli account AI sono al LIMITE vero; riprende al reset.
 * - `background_threshold`: gli account sono sopra la soglia di riserva per i
 *   lavori di sfondo (BACKGROUND_WEEKLY_THRESHOLD); riprende al reset o, dopo
 *   qualche ora, come lavoro interattivo (F2a).
 *
 * Sta in `@stubwise/notifications` (modulo puro, nessuna dipendenza) perché
 * la scrive e la confronta il worker e la legge `format.ts` qui accanto (la
 * resa delle card, anche di quelle già pubblicate: il testo si DERIVA A
 * LETTURA da qui). Non in `@stubwise/shared`: `format.ts` è nel grafo
 * dell'entry `./pure` (bundle mobile) e lì un import di VALORE da shared
 * trascinerebbe zod (vedi `pure.test.ts`).
 */

export const PROVIDER_LIMIT_PAUSE_REASON = "provider_limit" as const;
export const BACKGROUND_THRESHOLD_PAUSE_REASON = "background_threshold" as const;

export type DocsPauseReason =
  | typeof PROVIDER_LIMIT_PAUSE_REASON
  | typeof BACKGROUND_THRESHOLD_PAUSE_REASON;

/**
 * Le frasi della SOGLIA che versioni precedenti del worker hanno scritto in
 * `pause_reason` e nell'evento (git log -p di `apps/worker/src/docs/nodes.ts`
 * e `recursive/node-dispatch.ts`). Restano qui perché le card già in inbox le
 * contengono per sempre: nessun processo riscrive il jsonb delle notifiche.
 * Non aggiungerne di nuove: il worker scrive solo i codici.
 */
export const LEGACY_THRESHOLD_PAUSE_REASONS: readonly string[] = [
  "soglia del limite settimanale (lavoro di sfondo) superata su tutti gli account AI: riprende al reset settimanale",
  "soglia del limite settimanale (lavoro di sfondo) superata su tutti gli account AI: riprende al reset settimanale o, dopo DOCS_BACKGROUND_PAUSE_MAX_HOURS, come lavoro interattivo",
];

/**
 * Il codice di una reason COMUNQUE sia stata scritta: il codice stesso, una
 * frase storica della soglia → `background_threshold`; tutto il resto (la
 * frase storica del limite, un testo ignoto, un valore assente) →
 * `provider_limit`, che è l'unica pausa che esisteva prima della soglia.
 */
export function docsPauseReasonOf(stored: unknown): DocsPauseReason {
  if (stored === BACKGROUND_THRESHOLD_PAUSE_REASON) return BACKGROUND_THRESHOLD_PAUSE_REASON;
  if (typeof stored === "string" && LEGACY_THRESHOLD_PAUSE_REASONS.includes(stored)) {
    return BACKGROUND_THRESHOLD_PAUSE_REASON;
  }
  return PROVIDER_LIMIT_PAUSE_REASON;
}
