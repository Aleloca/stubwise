/**
 * Rimandi, lotto 5 (A9): di un test della credenziale fallito (il worker
 * scrive in `ai_providers.test_error` l'uscita del CLI o l'errore del run),
 * se la colpa è della RETE o della CREDENZIALE — le due parole del prototipo
 * (`unreachable` / `invalid_credentials`). Si DERIVA a lettura dal testo, non
 * si scrive: vale anche per gli esiti già salvati. Un testo che non dice
 * niente di riconoscibile resta «credenziale», come prima (un falso «rete»
 * farebbe riprovare invece di cambiare la chiave).
 */
const NETWORK = [
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /fetch failed/i,
  /network (error|request failed|is unreachable)/i,
  /connection (error|refused|reset|timed out)/i,
  /socket hang up/i,
  /getaddrinfo/i,
  /timed? ?out after/i,
  /\btimeout\b/i,
  // Il TLS e la richiesta che non arriva (review del lotto 5, M-4).
  /certificate (has expired|verify failed|is not yet valid)/i,
  /\bCERT_[A-Z_]+\b/,
  /request to \S+ failed/i,
];
// Review del lotto 5 (M-4): niente `/oauth/` né `/expired/` — compaiono anche
// negli errori di rete («OAuth refresh failed: ENOTFOUND», «certificate has
// expired»). Un rifiuto della credenziale lo dicono un 401/403 o le parole
// del rifiuto.
const CREDENTIAL = [/\b401\b/, /\b403\b/, /invalid[ _-]?(api[ _-]?)?key/i, /authenticat/i, /unauthori[sz]ed/i, /forbidden/i, /invalid (x-api-key|credentials?|token)/i];
/** Il rifiuto esplicito: un 401/403 o una chiave/credenziale non valida. Vince anche su un errore di rete. */
const EXPLICIT_REJECTION = [/\b401\b/, /\b403\b/, /invalid[ _-]?(api[ _-]?)?key/i, /invalid (x-api-key|credentials?|token)/i];

export type CredentialTestFailure = "invalid_credentials" | "unreachable";

export function credentialTestFailureOf(error: string | null | undefined): CredentialTestFailure {
  const text = error ?? "";
  // Un rifiuto esplicito vince sempre (un 401 dopo un ritentativo di rete).
  if (EXPLICIT_REJECTION.some((re) => re.test(text))) return "invalid_credentials";
  // Poi la rete: un codice E* o «fetch failed» senza 401/403 è la rete, anche
  // se il testo parla di autenticazione («authentication request failed: ECONNRESET»).
  if (NETWORK.some((re) => re.test(text))) return "unreachable";
  if (CREDENTIAL.some((re) => re.test(text))) return "invalid_credentials";
  return "invalid_credentials";
}
