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
];
const CREDENTIAL = [/\b401\b/, /\b403\b/, /invalid[ _-]?(api[ _-]?)?key/i, /authenticat/i, /unauthori[sz]ed/i, /forbidden/i, /invalid (x-api-key|credentials?|token)/i, /oauth/i, /expired/i];

export type CredentialTestFailure = "invalid_credentials" | "unreachable";

export function credentialTestFailureOf(error: string | null | undefined): CredentialTestFailure {
  const text = error ?? "";
  // La credenziale vince se il testo la nomina: un 401 dopo una richiesta riuscita alla rete.
  if (CREDENTIAL.some((re) => re.test(text))) return "invalid_credentials";
  if (NETWORK.some((re) => re.test(text))) return "unreachable";
  return "invalid_credentials";
}
