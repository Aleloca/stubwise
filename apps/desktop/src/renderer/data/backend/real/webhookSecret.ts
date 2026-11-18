import { ApiError } from "@stubwise/api-client";
import type { ProjectRefusal, ProjectResult } from "../../projectSettings/types";

// Area 9, F5: la rigenerazione del segreto del webhook git di un repository
// (72, 7da256def; client 0f8a80bba) nel risultato della pagina. Il segreto
// esce qui, una volta. `rollback` non è un successo: resta il vecchio, e se
// la piattaforma non è tornata indietro i due sono divisi (si riprova).

type Outcome = ProjectResult<{ secret: string; mode: "manual" | "platform" }>;

const invalid = (reason: string): Outcome => ({ ok: false, error: "invalid", reason }) as Outcome;

/** La risposta del server (`mode` è un enum aperto: l'ignoto è `__unknown__`). */
export function webhookSecretOutcome(r: {
  mode: string;
  webhookSecret?: string;
  platformRestored?: boolean;
}): Outcome {
  if (r.mode === "rollback")
    return invalid(r.platformRestored ? "webhook_rollback" : "webhook_split");
  if ((r.mode === "manual" || r.mode === "platform") && r.webhookSecret)
    return { ok: true, secret: r.webhookSecret, mode: r.mode };
  return invalid("webhook_unknown");
}

/** I rifiuti: lo scope del token, la piattaforma che rifiuta, la riconferma. */
export function webhookSecretRefusal(error: unknown): ProjectRefusal {
  if (!(error instanceof ApiError)) throw error;
  const code = error.code ?? "";
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (code === "webhook_scope_missing" || code === "platform_update_failed")
    return { ok: false, error: "invalid", reason: code } as ProjectRefusal;
  if (error.status === 404) return { ok: false, error: "not_found" };
  if (error.status === 403) return { ok: false, error: "forbidden" };
  throw error;
}
