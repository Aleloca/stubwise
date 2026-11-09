import { createHash, randomBytes } from "node:crypto";

// Il login del desktop passa dal browser di sistema (integrazione area 2,
// 9 nov 2026: una passkey vive sul dominio dell'istanza, e dentro la finestra
// di un'app non firmata non funziona). PKCE:
//
// 1. `start()` genera `state` e `code_verifier`, tiene in memoria UNA sola
//    richiesta pendente (5 minuti) e apre nel browser
//    `<istanza>/app/#/desktop-login?challenge=<S256(verifier)>&state=<s>&device=<nome>`.
// 2. Il browser, dopo il login completo e «Allow», riapre l'app con
//    `stubwise://auth?code=…&state=…`.
// 3. `handleAuthUrl()` accetta SOLO quell'URL con lo state pendente, scambia
//    codice + verifier (`POST /api/auth/desktop-exchange`), salva il token e
//    avvisa il renderer.
//
// Il verifier e il token non lasciano mai il processo main: nel browser va
// solo il challenge, al renderer solo l'esito e l'utente.

export type LoginResult = { ok: true; user: unknown } | { ok: false; code: string };

/** Quello che il renderer riceve su `session:changed`: mai il token. */
export type SessionChange = { signedIn: true; user: unknown } | { signedIn: false; error?: string };

export interface BrowserLoginDeps {
  instanceUrl: () => string | null;
  openExternal: (url: string) => Promise<void> | void;
  hostname: () => string;
  saveToken: (token: string, patId: string | null) => void;
  notify: (change: SessionChange) => void;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Quanto aspetta l'app il ritorno dal browser. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

// Gli stessi caratteri che il server rifiuta in `deviceName` (a capo, bidi).
const FORBIDDEN = /[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/** Il nome del Mac per `Desktop · <nome>`: senza `.local`, pulito, ≤60 caratteri. */
export function deviceNameFrom(hostname: string): string {
  const clean = hostname.replace(/\.local$/i, "").replace(FORBIDDEN, "").trim().slice(0, 60).trim();
  return clean || "Mac";
}

interface Pending {
  state: string;
  verifier: string;
  deviceName: string;
  expiresAt: number;
}

export function createBrowserLogin(deps: BrowserLoginDeps) {
  const now = deps.now ?? Date.now;
  let pending: Pending | null = null;

  async function start(): Promise<{ ok: true; state: string } | { ok: false; code: string }> {
    const instance = deps.instanceUrl();
    if (!instance) return { ok: false, code: "no_instance" };
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const deviceName = deviceNameFrom(deps.hostname());
    // Una sola richiesta pendente: un nuovo avvio sostituisce la precedente.
    pending = { state, verifier, deviceName, expiresAt: now() + PENDING_TTL_MS };
    const query = new URLSearchParams({ challenge, state, device: deviceName });
    await deps.openExternal(`${instance}/app/#/desktop-login?${query.toString()}`);
    return { ok: true, state };
  }

  function cancel(): void {
    pending = null;
  }

  /**
   * Un URL `stubwise://` arrivato all'app. Tutto ciò che non è
   * `stubwise://auth?code&state` con lo state pendente (e non scaduto) è
   * IGNORATO (`null`): nessuna rete, nessun avviso.
   */
  async function handleAuthUrl(raw: string): Promise<LoginResult | null> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.protocol !== "stubwise:" || url.hostname !== "auth") return null;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !pending || state !== pending.state) return null;
    const current = pending;
    // Monouso, anche se lo scambio fallisce: un secondo URL con lo stesso
    // state è ignorato.
    pending = null;
    if (now() > current.expiresAt) return null;

    const instance = deps.instanceUrl();
    const fail = (codeName: string): LoginResult => {
      deps.notify({ signedIn: false, error: codeName });
      return { ok: false, code: codeName };
    };
    if (!instance) return fail("no_instance");
    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(`${instance}/api/auth/desktop-exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, codeVerifier: current.verifier, deviceName: current.deviceName }),
      });
    } catch {
      return fail("network_error");
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) return fail(typeof body?.code === "string" ? body.code : `http_${res.status}`);
    if (!body || typeof body.token !== "string") return fail("invalid_response");
    deps.saveToken(body.token, typeof body.patId === "string" ? body.patId : null);
    const user = body.user ?? null;
    deps.notify({ signedIn: true, user });
    return { ok: true, user };
  }

  return { start, cancel, handleAuthUrl };
}

/** Il primo argomento `stubwise://…` di una riga di comando (Windows/Linux, seconda istanza). */
export function authUrlFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith("stubwise://")) ?? null;
}
