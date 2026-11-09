import { hostname as osHostname } from "node:os";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// La sessione dell'app desktop (integrazione area 2, fetta 1): un PAT
// rilasciato da `POST /api/auth/mobile-login` (la porta con il secondo
// fattore, `docs/invariants/second-factor.md`), cifrato con `safeStorage`
// (Keychain su Mac) in `session.bin`. Il token NON lascia mai il processo
// main: il renderer riceve solo esiti e l'utente della sessione.

interface Stored {
  token: string;
  patId: string | null;
}

let memory: Stored | null = null;
const file = () => join(app.getPath("userData"), "session.bin");

/**
 * Salva il token. Senza cifratura del sistema disponibile resta solo in
 * memoria: niente in chiaro su disco, e al prossimo avvio si rifà il login.
 */
export function saveToken(token: string, patId: string | null = null): void {
  memory = { token, patId };
  if (!safeStorage.isEncryptionAvailable()) return;
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(memory)));
}

function stored(): Stored | null {
  if (memory) return memory;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file()))) as Partial<Stored>;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    memory = { token: parsed.token, patId: typeof parsed.patId === "string" ? parsed.patId : null };
    return memory;
  } catch {
    return null;
  }
}

export function readToken(): string | null {
  return stored()?.token ?? null;
}

export function readPatId(): string | null {
  return stored()?.patId ?? null;
}

export function clearToken(): void {
  memory = null;
  rmSync(file(), { force: true });
}

/** Solo per i test: dimentica la copia in memoria, come un riavvio. */
export function forgetMemory(): void {
  memory = null;
}

// --- login e logout ------------------------------------------------------------

export type LoginResult = { ok: true; user: unknown } | { ok: false; code: string };

interface LoginDeps {
  instanceUrl: string | null;
  hostname?: string;
  fetch?: typeof fetch;
}

function parseLoginInput(raw: unknown): { email: string; password: string; code?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const { email, password, code } = raw as Record<string, unknown>;
  if (typeof email !== "string" || email.trim() === "" || email.length > 320) return null;
  if (typeof password !== "string" || password === "" || password.length > 1024) return null;
  if (code !== undefined && (typeof code !== "string" || code.length > 64)) return null;
  return { email: email.trim(), password, ...(code ? { code } : {}) };
}

/**
 * `session:login`: chiama `mobile-login` con `deviceName = "Desktop · <host>"`,
 * salva il token e restituisce l'utente, MAI il token. Un errore torna col
 * codice del server (`invalid_credentials`, `second_factor_required`…).
 */
export async function login(raw: unknown, deps: LoginDeps): Promise<LoginResult> {
  const input = parseLoginInput(raw);
  if (!input) return { ok: false, code: "invalid_request" };
  if (!deps.instanceUrl) return { ok: false, code: "no_instance" };
  const host = (deps.hostname ?? osHostname()).slice(0, 60) || "Mac";
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.instanceUrl}/api/auth/mobile-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, deviceName: `Desktop · ${host}` }),
    });
  } catch {
    return { ok: false, code: "network_error" };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    return { ok: false, code: typeof body?.code === "string" ? body.code : `http_${res.status}` };
  }
  if (!body || typeof body.token !== "string") return { ok: false, code: "invalid_response" };
  saveToken(body.token, typeof body.patId === "string" ? body.patId : null);
  return { ok: true, user: body.user ?? null };
}

/**
 * `session:logout`: revoca il PAT sul server (best-effort, ma mai
 * silenzioso) e cancella comunque il token locale.
 */
export async function logout(deps: { instanceUrl: string | null; fetch?: typeof fetch }): Promise<void> {
  const token = readToken();
  const patId = readPatId();
  try {
    if (deps.instanceUrl && token && patId) {
      const res = await (deps.fetch ?? fetch)(
        `${deps.instanceUrl}/api/pats/${encodeURIComponent(patId)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok && res.status !== 404) {
        console.warn(`stubwise: logout — revoca del PAT fallita (HTTP ${res.status})`);
      }
    }
  } catch (error) {
    console.warn("stubwise: logout — revoca del PAT fallita (best-effort)", error);
  } finally {
    clearToken();
  }
}
