import { randomBytes } from "node:crypto";
import { googleCallbackOutcomes, type GoogleCallbackOutcome } from "@stubwise/shared";

// Lotto 4, §6 (`docs/plans/2026-11-23-rimandi-lotto4-contratti.md`): il
// ritorno dal consenso di Google al desktop, come `stubwise://auth` del
// login (`browserLogin.ts`).
//
// 1. `prepare()` genera il `returnState`, tiene in memoria UNA sola
//    richiesta pendente (10 minuti, come lo state del server) e lo dà al
//    renderer, che lo manda in `POST /api/me/google/connect`.
// 2. Il callback del server porta il browser alla pagina dell'istanza, che
//    riapre l'app con `stubwise://google?outcome=<esito>&state=<returnState>`.
// 3. `handleGoogleUrl()` accetta SOLO quell'URL con lo state pendente e un
//    esito di `googleCallbackOutcomes`, una volta sola, e avvisa il renderer
//    con `{ state, outcome }`. Tutto il resto è ignorato, senza avvisi.
//
// L'esito non è un'autorità (chiunque può aprire un `stubwise://google`): il
// renderer conferma `ok` rileggendo le caselle. Nell'URL non c'è niente di
// segreto, e al renderer non passa nient'altro.

export type GoogleReturn = { state: string; outcome: GoogleCallbackOutcome };

export interface GoogleReturnDeps {
  notify: (ret: GoogleReturn) => void;
  now?: () => number;
}

/** Quanto aspetta l'app il ritorno dal consenso di Google. */
export const GOOGLE_RETURN_TTL_MS = 10 * 60 * 1000;

const OUTCOMES: ReadonlySet<string> = new Set(googleCallbackOutcomes);

export function createGoogleReturn(deps: GoogleReturnDeps) {
  const now = deps.now ?? Date.now;
  let pending: { state: string; expiresAt: number } | null = null;

  /** Una richiesta nuova: sostituisce la precedente. */
  function prepare(): { state: string } {
    const state = randomBytes(16).toString("base64url");
    pending = { state, expiresAt: now() + GOOGLE_RETURN_TTL_MS };
    return { state };
  }

  /** Il dialogo chiuso durante l'attesa: il ritorno che arriva dopo si ignora. */
  function cancel(): void {
    pending = null;
  }

  function handleGoogleUrl(raw: string): GoogleReturn | null {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "stubwise:" || url.hostname !== "google") return null;
    const state = url.searchParams.get("state");
    const outcome = url.searchParams.get("outcome");
    if (!pending || !state || state !== pending.state) return null;
    if (!outcome || !OUTCOMES.has(outcome)) return null;
    const current = pending;
    // Monouso, anche se è scaduto.
    pending = null;
    if (now() > current.expiresAt) return null;
    const ret: GoogleReturn = { state, outcome: outcome as GoogleCallbackOutcome };
    deps.notify(ret);
    return ret;
  }

  return { prepare, cancel, handleGoogleUrl };
}
