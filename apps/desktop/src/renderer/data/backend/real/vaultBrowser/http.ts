import { primitives } from "./primitives";

// Le rotte della cassaforte nel browser (design §3): sopra il `fetch`
// CATTURATO al primo import (§2.4), stessa origine e cookie di sessione, NON
// dall'api-client (che le esclude apposta, `endpoints/vault.ts`). Le
// risposte si validano con gli schemi di `@stubwise/shared` dove servono.

/** Un rifiuto del server: lo stato, il codice, il corpo e i secondi di `Retry-After`. */
export class VaultHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export async function vaultHttp<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await primitives.fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new VaultHttpError(0, "network");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new VaultHttpError(
      res.status,
      typeof data?.code === "string" ? data.code : `http_${res.status}`,
      data,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}
