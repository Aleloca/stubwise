import { request } from "./client";

// Show e Copy nella build web (design §6, revisione I-1): la decifratura la
// fa il worker, con la chiave della voce non estraibile; alla pagina arriva la
// sola password, che non entra mai in React Query (la tiene il componente che
// la mostra). Una password che arriva dopo la chiusura il worker la scarta.

export type RevealOutcome =
  | { ok: true; password: string }
  | { ok: false; code: string; retryAfterSeconds?: number };

export function revealPassword(
  id: string,
  action: "show" | "copy",
  personId: string,
  sessionTag: string,
): Promise<RevealOutcome> {
  return request<RevealOutcome>({ t: "reveal", id, action, personId, sessionTag });
}
