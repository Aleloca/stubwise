/**
 * Le credenziali dentro un URL (`scheme://user:pass@host`), come il server
 * (`apps/server/src/services/url-credentials.ts`, revisione del lotto 5 della
 * parità MCP, M6): il finto le tiene in chiaro nello stato, come l'agente, e
 * le mostra mascherate a chi legge.
 */

const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi;

/** La maschera della password: un target che la contiene è una lettura rimandata indietro. */
export const MASKED_PASSWORD = "***";

/** `https://user:pass@host/…` → `https://user:***@host/…`; il resto invariato. */
export function maskUrlCredentials(text: string): string {
  return text.replace(
    CREDENTIALS,
    (_m, scheme: string, user: string) => `${scheme}${user}:${MASKED_PASSWORD}@`,
  );
}

/** Se il testo contiene un URL con una password. */
export function hasUrlCredentials(text: string): boolean {
  return [...text.matchAll(CREDENTIALS)].length > 0;
}

/** Se il testo contiene un URL la cui password è la maschera. */
export function hasMaskedCredentials(text: string): boolean {
  return [...text.matchAll(CREDENTIALS)].some((m) => m[3] === MASKED_PASSWORD);
}
