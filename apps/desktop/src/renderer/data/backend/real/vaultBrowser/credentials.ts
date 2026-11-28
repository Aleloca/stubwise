import { request } from "./client";
import type { Presence } from "./core";

// Le operazioni sulle password nella build web (design §6, §10; revisione
// I-1): la crittografia la fa il worker.
// - Show e Copy: la chiave della voce non estraibile; alla pagina arriva la
//   sola password, che non entra mai in React Query (la tiene il componente
//   che la mostra). Una password che arriva dopo la chiusura il worker la
//   scarta.
// - Crea e cambia: la pagina manda la password digitata, il worker la cifra
//   per i destinatari e non la restituisce. Crea non vuole la cassaforte
//   aperta (le pubbliche bastano); cambia sì, con la sessione dell'apertura.
// - Condividi e togli: con la cassaforte aperta e la prova di possesso, che
//   il worker chiede e consuma; alla pagina solo l'esito.
// - Chi aspetta (senza la chiave, senza le copie), conferma e rifiuta (con la
//   cassaforte aperta e la prova).

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

export type WriteOutcome = { ok: true; resaved?: boolean } | { ok: false; code: string };

export function createInWorker(
  projectId: string,
  fields: Record<string, unknown>,
  password: string,
): Promise<{ ok: true; id: string; resaved?: boolean } | { ok: false; code: string }> {
  return request({ t: "create", projectId, fields, password });
}

export function setPasswordInWorker(id: string, password: string, personId: string, sessionTag: string): Promise<WriteOutcome> {
  return request<WriteOutcome>({ t: "setPassword", id, password, personId, sessionTag });
}

export function shareInWorker(
  id: string,
  target: { userId: string } | { roleId: string },
  personId: string,
  sessionTag: string,
): Promise<{ ok: true; waiting: string[] } | { ok: false; code: string }> {
  return request({ t: "share", id, target, personId, sessionTag });
}

export function removeReaderInWorker(
  id: string,
  readerId: string,
  personId: string,
  sessionTag: string,
  presence: Presence,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return request({ t: "removeReader", id, readerId, personId, sessionTag, presence });
}

export type PendingItem = {
  userId: string;
  email: string;
  personKeyId: string;
  status: "pending" | "confirmed";
  createdAt: string;
  device: string | null;
  fingerprint: string;
  credentials: { id: string; projectId: string; service: string; label: string | null }[];
};

export function pendingInWorker(): Promise<{ ok: true; items: PendingItem[] } | { ok: false; code: string }> {
  return request({ t: "pending" });
}

export type ConfirmOutcome =
  | { ok: true; saved: number; keyChanged: number; notAllowed: number; unopenable: number }
  | { ok: false; code: string };

export function confirmInWorker(keyId: string, personId: string, sessionTag: string, presence: Presence): Promise<ConfirmOutcome> {
  return request<ConfirmOutcome>({ t: "confirm", keyId, personId, sessionTag, presence });
}

export function rejectInWorker(
  keyId: string,
  personId: string,
  sessionTag: string,
  presence: Presence,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return request({ t: "reject", keyId, personId, sessionTag, presence });
}

