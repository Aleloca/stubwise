/**
 * Le credenziali dentro un URL (`scheme://user:pass@host`), in UN posto
 * (revisione del lotto 5 della parità MCP, I1 e M6). Le usa il registro delle
 * modifiche, per mascherarle in qualunque prima/dopo, e i controlli http di un
 * server, che le tengono in chiaro solo per l'agente (`/monitor/config`) e le
 * mostrano mascherate a chi legge.
 */

const CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]+)@/gi;

/** La maschera della password. Un target che la contiene è una lettura rimandata indietro, mai una password vera. */
export const MASKED_PASSWORD = "***";

/** `https://user:pass@host/…` → `https://user:***@host/…`; il resto invariato. */
export function maskUrlCredentials(text: string): string {
  return text.replace(CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${MASKED_PASSWORD}@`);
}

/** Se il testo contiene un URL con una password. */
export function hasUrlCredentials(text: string): boolean {
  return [...text.matchAll(CREDENTIALS)].length > 0;
}

/** Se il testo contiene un URL la cui password è la maschera. */
export function hasMaskedCredentials(text: string): boolean {
  return [...text.matchAll(CREDENTIALS)].some((m) => m[3] === MASKED_PASSWORD);
}

/** L'URL di un webhook come entra nel registro: host e ultime 4 cifre. */
export function maskedUrl(url: string): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = "?";
  }
  return `${host} …${url.slice(-4)}`;
}
