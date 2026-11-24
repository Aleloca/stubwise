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
}

class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
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
      );
    }
    return res;
  }

  /** Il corpo validato con lo schema di `@stubwise/shared` (72): fuori forma è un errore. */
  async function parsed<T>(res: Response, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): Promise<T> {
    const out = schema.safeParse(await res.json().catch(() => null));
    if (!out.success) throw new Error("invalid_response");
    return out.data;
  }

  return {
    async pair(devicePublicKey, deviceName) {
      const res = await call("POST", "/api/vault/device-pairings", { devicePublicKey, deviceName });
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
        if (error instanceof VaultHttpError && error.status === 404) return { revoked: true };
        throw error;
      }
    },
    async forgetRemote() {
      await call("DELETE", "/api/vault/device-seals/mine");
    },
  };
}
