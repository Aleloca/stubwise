import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";

// La sessione dell'app desktop (integrazione area 2, fetta 1): un PAT
// `kind = 'desktop'` rilasciato da `POST /api/auth/desktop-exchange` dopo il
// login nel browser (`browserLogin.ts`, `docs/invariants/second-factor.md`), cifrato con `safeStorage`
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

/**
 * Un login nuovo (dal browser): salva il token e revoca il PAT di prima, se
 * c'era ed era un altro — best-effort, mai silenzioso. Il token nuovo resta
 * comunque: una revoca fallita lascia un PAT in più, non una sessione persa.
 */
export async function replaceToken(
  token: string,
  patId: string | null,
  deps: { instanceUrl: string | null; fetch?: typeof fetch },
): Promise<void> {
  const previous = stored();
  saveToken(token, patId);
  if (!previous || previous.token === token || !previous.patId || !deps.instanceUrl) return;
  try {
    const res = await (deps.fetch ?? fetch)(
      `${deps.instanceUrl}/api/pats/${encodeURIComponent(previous.patId)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${previous.token}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 401) {
      console.warn(`stubwise: login — revoca del PAT di prima fallita (HTTP ${res.status})`);
    }
  } catch (error) {
    console.warn("stubwise: login — revoca del PAT di prima fallita (best-effort)", error);
  }
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

// --- logout -------------------------------------------------------------------
//
// Il login non passa più da qui: dal 9 nov 2026 il desktop entra dal browser
// di sistema (`browserLogin.ts`, PKCE + `stubwise://`). Il login con password
// via `mobile-login` è stato tolto.

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
