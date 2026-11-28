import { ApiError } from "@stubwise/api-client";
import { keyFingerprint } from "@stubwise/vault-crypto";
import type * as Fake from "../../api";
import type { MacView, VaultFailure } from "../../vault/types";
import { appClient } from "./client";

// Amministrazione → una persona → Vault: i Mac di un'altra persona (D-6),
// solo full admin. Le rotte (`/api/vault/users/:userId/device-seals`) sono del
// BROWSER (`browserOnly`, il cookie di sessione): nella nuova app nel browser
// (`/app`) si chiamano da qui; nell'app desktop (PAT) il server le rifiuta, e
// la parte apre la stessa pagina della nuova app nel browser (ritiro del web
// vecchio, inventario 1.2: prima il link portava a una pagina del web vecchio
// che non esiste).

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

const failOf = (error: unknown): VaultFailure => {
  if (error instanceof ApiError) {
    if (error.code === "reauth_required") return { ok: false, code: "reauth_required" };
    if (error.status === 404) return { ok: false, code: "not_found" };
    if (error.status === 403) return { ok: false, code: "forbidden" };
  }
  throw error;
};

const path = (personId: string) => `/api/vault/users/${encodeURIComponent(personId)}/device-seals`;

export const listMacsOf: typeof Fake.vault.listMacsOf = async (personId) => {
  try {
    const r = (await appClient().request("GET", path(personId))) as { items: Any[] };
    const macs: MacView[] = await Promise.all(
      r.items.map(async (m) => ({
        id: m.id,
        name: m.deviceName,
        pairedAt: m.createdAt,
        lastUsedAt: m.lastUsedAt,
        fingerprint: await keyFingerprint(m.devicePublicKey),
        // I Mac di un ALTRO: nessuno è «questo Mac».
        current: false,
      })),
    );
    return { ok: true, macs };
  } catch (error) {
    return failOf(error);
  }
};

export const removeMacOf: typeof Fake.vault.removeMacOf = async (personId, macId) => {
  try {
    await appClient().request("DELETE", `${path(personId)}/${encodeURIComponent(macId)}`);
    return { ok: true };
  } catch (error) {
    return failOf(error);
  }
};
