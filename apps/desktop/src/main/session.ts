import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { readInstanceUrl } from "./instance";

// La sessione dell'app desktop (integrazione area 2, fetta 1): un PAT
// `kind = 'desktop'` rilasciato da `POST /api/auth/desktop-exchange` dopo il
// login nel browser (`browserLogin.ts`, `docs/invariants/second-factor.md`), cifrato con `safeStorage`
// (Keychain su Mac) in `session.bin`. Il token NON lascia mai il processo
// main: il renderer riceve solo esiti e l'utente della sessione.
//
// I3 (seconda revisione di sicurezza della cassaforte): `instance.json` non è
// un segreto, e chi lo riscriveva mandava il PAT a un host suo. Il token sta
// nel blob cifrato INSIEME all'istanza dello scambio, ed esce solo se
// l'istanza attuale è quella; altrimenti la sessione si chiude e il main lo
// sa (`onSessionMismatch` → `sessionChanged`). Una sessione salvata prima,
// senza istanza, non vale: si rifà il login.

interface Stored {
  token: string;
  patId: string | null;
  instanceUrl: string;
}

let mismatchListener: (() => void) | null = null;

/** Il main sente quando un token è stato scartato perché l'istanza non è la sua. */
export function onSessionMismatch(listener: () => void): void {
  mismatchListener = listener;
}

let memory: Stored | null = null;
const file = () => join(app.getPath("userData"), "session.bin");

/**
 * Salva il token. Senza cifratura del sistema disponibile resta solo in
 * memoria: niente in chiaro su disco, e al prossimo avvio si rifà il login.
 */
export function saveToken(token: string, patId: string | null, instanceUrl: string): void {
  memory = { token, patId, instanceUrl };
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
  if (!deps.instanceUrl) return;
  const previous = stored();
  // L'istanza dello SCAMBIO, non quella del momento (che può essere cambiata).
  saveToken(token, patId, deps.instanceUrl);
  if (!previous || previous.token === token || !previous.patId) return;
  try {
    // Il PAT di prima si revoca sulla SUA istanza, col suo bearer.
    const res = await (deps.fetch ?? fetch)(
      `${previous.instanceUrl}/api/pats/${encodeURIComponent(previous.patId)}`,
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
    if (typeof parsed.instanceUrl !== "string" || parsed.instanceUrl === "") return null;
    memory = {
      token: parsed.token,
      patId: typeof parsed.patId === "string" ? parsed.patId : null,
      instanceUrl: parsed.instanceUrl,
    };
    return memory;
  } catch {
    return null;
  }
}

/** La sessione, solo se è dell'istanza attuale; un'altra la chiude (I3). */
function current(): Stored | null {
  const s = stored();
  if (!s) return null;
  if (s.instanceUrl === readInstanceUrl()) return s;
  clearToken();
  mismatchListener?.();
  return null;
}

export function readToken(): string | null {
  return current()?.token ?? null;
}

export function readPatId(): string | null {
  return current()?.patId ?? null;
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
export async function logout(deps: {
  instanceUrl: string | null;
  fetch?: typeof fetch;
}): Promise<void> {
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
