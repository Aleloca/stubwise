import type { TFunction } from "i18next";

/**
 * La riga del controllo finale di una correzione di server (d3): l'intestazione
 * nella lingua di chi guarda, decisa da `resolved` (R-L3); dopo, il dettaglio
 * scritto da Claude così com'è. Per ogni altro evento, il suo testo.
 */
export function serverCheckText(
  e: { kind: string; text: string; resolved?: boolean; detail?: string },
  t: TFunction,
): string {
  if (e.kind !== "server_check" || e.resolved === undefined) return e.text;
  const head = t(`taskDetail.server.check.${e.resolved ? "resolved" : "notResolved"}`);
  return e.detail ? `${head} — ${e.detail}` : head;
}
