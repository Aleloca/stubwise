import { vaultDevicePairingResponseSchema, vaultDeviceSealMineSchema } from "@stubwise/shared";
import type { SealResponse } from "./vaultLock";

// Le rotte del sigillo del dispositivo che chiama il main col PAT desktop
// (lotto 10, la forma di 72): l'accoppiamento, il proprio sigillo, «Dimentica
// questo Mac». Il token non esce da qui; il renderer non le raggiunge
// (`isVaultOnlyPath` in `apiProxy.ts`).

export interface VaultRemoteDeps {
  instanceUrl: () => string | null;
  token: () => string | null;
  fetch?: typeof fetch;
}

export interface Pairing {
  state: string;
  deviceId: string;
  expiresAt: string;
}

export interface VaultRemote {
  pair: (devicePublicKey: string, deviceName: string) => Promise<Pairing>;
  fetchSeal: () => Promise<SealResponse>;
  forgetRemote: () => Promise<void>;
  /**
   * Una rotta della cassaforte col PAT desktop (a912fbcb8): il corpo JSON
   * della risposta (null per un 204), o `VaultHttpError` col codice e i
   * dettagli (un 409 `recipients_changed` porta i destinatari attuali).
   */
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
}

/**
 * L'interruttore d'istanza `VAULT_DESKTOP` spento (72, 785387279, di default):
 * le rotte del Mac rispondono 404 `not_found`. È diverso da
 * `device_seal_not_found` (sigillo tolto) e da `device_seal_required` (da
 * associare): la cassaforte dal desktop non è abilitata, si apre dal browser.
 */
export const isDisabled = (error: unknown): boolean =>
  error instanceof VaultHttpError && error.status === 404 && error.code === "not_found";

/** Un errore del server: lo stato, il codice (il messaggio) e i dettagli del corpo. */
export class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export function createVaultRemote(deps: VaultRemoteDeps): VaultRemote {
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const base = deps.instanceUrl();
    const token = deps.token();
    if (!base || !token) throw new Error("no_session");
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await (deps.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
      throw new VaultHttpError(
        res.status,
        typeof data?.code === "string" ? data.code : `http_${res.status}`,
        data,
      );
    }
    return res;
  }

  /** Il corpo validato con lo schema di `@stubwise/shared` (72): fuori forma è un errore. */
  async function parsed<T>(
    res: Response,
    schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  ): Promise<T> {
    const out = schema.safeParse(await res.json().catch(() => null));
    if (!out.success) throw new Error("invalid_response");
    return out.data;
  }

  return {
    async pair(devicePublicKey, deviceName) {
      const res = await call("POST", "/api/vault/device-pairings", {
        devicePublicKey,
        deviceName,
      }).catch((error: unknown) => {
        throw isDisabled(error) ? new Error("vault_desktop_disabled") : error;
      });
      const p = await parsed(res, vaultDevicePairingResponseSchema);
      return { state: p.state, deviceId: p.deviceId, expiresAt: p.expiresAt };
    },
    async fetchSeal() {
      try {
        const res = await call("GET", "/api/vault/device-seals/mine");
        const s = await parsed(res, vaultDeviceSealMineSchema);
        return {
          id: s.id,
          deviceName: s.deviceName,
          personKeyId: s.personKeyId,
          personPublicKey: s.personPublicKey,
          seal: s.seal,
        };
      } catch (error) {
        // Nessun sigillo, tolto, o chiave di persona non più quella attuale: la revoca (D-5).
        // M2: solo il codice della rotta, non un 404 qualunque (un proxy, una rotta che non c'è).
        if (
          error instanceof VaultHttpError &&
          error.status === 404 &&
          error.code === "device_seal_not_found"
        )
          return { revoked: true };
        if (isDisabled(error)) return { disabled: true };
        throw error;
      }
    },
    async forgetRemote() {
      // Spento sull'istanza: non c'è niente da togliere, e va bene così.
      await call("DELETE", "/api/vault/device-seals/mine").catch((error: unknown) => {
        if (!isDisabled(error)) throw error;
      });
    },
    async request(method, path, body) {
      const res = await call(method, path, body);
      if (res.status === 204) return null;
      return res.json().catch(() => null);
    },
  };
}
