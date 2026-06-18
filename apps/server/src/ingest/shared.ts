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
 * Compone l'URL del ticket: assoluto se publicUrl è valorizzato, altrimenti il
 * solo path relativo.
 */
export function ticketUrl(publicUrl: string | undefined, ticketId: string): string {
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  return `${base}/tickets/${ticketId}`;
}
