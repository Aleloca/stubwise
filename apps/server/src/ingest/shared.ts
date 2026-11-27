import { appUrl } from "@stubwise/shared";
import { ticketAppUrl, type DbOrTx } from "@stubwise/notifications";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/**
 * publicUrl dell'app, o undefined se non configurato. Il decorator espone un
 * getter che ESPLODE quando l'app è stata costruita senza publicUrl (alcuni
 * unit test): qui la notifica/link è opzionale, quindi assorbiamo l'errore e
 * lasciamo che il link al ticket sia il solo path.
 */
export function publicUrlOrUndefined(app: FastifyInstance): string | undefined {
  try {
    return app.publicUrl;
  } catch {
    return undefined;
  }
}

/**
 * Confronto a tempo costante tra chiave fornita e attesa. Con lunghezze
 * diverse timingSafeEqual non è applicabile: si paga comunque un confronto
 * della stessa forma per non rendere la lunghezza osservabile dal timing.
 */
export function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * L'URL della task nella nuova app (`app-links`, ritiro del web vecchio):
 * assoluto se publicUrl è valorizzato, altrimenti il percorso. Vuole il DB: la
 * nuova app apre una task col suo codice (`<CODE>-<n>`), non con l'id.
 */
export function ticketUrl(db: DbOrTx, publicUrl: string | undefined, ticketId: string): Promise<string> {
  // Mai lancia: chi lo chiama ha già scritto (il ticket, il commit); una lettura
  // che fallisce dà la Home della nuova app, non un 500 a cose fatte (M1).
  return ticketAppUrl(db, publicUrl, ticketId).catch(() => appUrl(publicUrl, { to: "home" }));
}
