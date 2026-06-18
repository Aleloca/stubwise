import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Finestra di tolleranza anti-replay sul timestamp della richiesta Slack: 5
 * minuti (300s) in entrambe le direzioni, come da raccomandazione Slack. Una
 * richiesta col timestamp fuori da questa finestra viene rifiutata anche se la
 * firma è formalmente corretta (protezione dai replay).
 */
const MAX_SKEW_SECONDS = 300;

export interface VerifySlackSignatureInput {
  /** Corpo grezzo della richiesta (la firma è calcolata su questo, non sul parse). */
  rawBody: string;
  /** Header `X-Slack-Signature` (`v0=<hmac hex>`), o undefined se assente. */
  signature: string | undefined;
  /** Header `X-Slack-Request-Timestamp` (epoch in secondi), o undefined se assente. */
  timestamp: string | undefined;
  /** Signing secret dell'app Slack (in chiaro, già decifrato dal chiamante). */
  signingSecret: string;
  /** Istante corrente in millisecondi (iniettabile nei test). */
  now: number;
}

/**
 * Verifica la firma di una richiesta Slack secondo lo schema ufficiale:
 *
 * 1. Base string = `v0:{timestamp}:{rawBody}`.
 * 2. HMAC-SHA256 della base string con il signing secret → `v0=<hex>`.
 * 3. Confronto a tempo costante con l'header `X-Slack-Signature`.
 *
 * Rifiuta (false) se: header firma/timestamp assenti, timestamp non numerico,
 * timestamp fuori dalla finestra ±300s (anti-replay), o firma non combaciante.
 * Funzione pura: `now` è iniettato per rendere deterministici i test.
 */
export function verifySlackSignature(input: VerifySlackSignatureInput): boolean {
  const { rawBody, signature, timestamp, signingSecret, now } = input;
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Anti-replay: scarta i timestamp troppo vecchi o troppo nel futuro.
  if (Math.abs(now / 1000 - ts) > MAX_SKEW_SECONDS) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;

  // timingSafeEqual richiede lunghezze uguali: con lunghezze diverse si paga
  // comunque un confronto della stessa forma per non rendere osservabile dal
  // timing la differenza di lunghezza, poi si ritorna false.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
