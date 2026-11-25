import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

// Il ponte fra il main e l'helper Swift del Secure Enclave
// (`native/keyhelper/main.swift`; revisione di sicurezza della cassaforte,
// I1). Una richiesta JSON su stdin, una risposta JSON su stdout: nessun
// segreto passa per argomenti o variabili d'ambiente. L'helper sta nel
// pacchetto accanto all'eseguibile (`Contents/MacOS/stubwise-keyhelper`) ed
// è firmato con l'app.

/** Esegue l'helper con `input` su stdin e restituisce lo stdout. */
export type HelperRunner = (input: string) => Promise<string>;

export interface KeyHelper {
  available: () => Promise<{ secureEnclave: boolean; biometry: boolean }>;
  /** Una chiave nuova nell'enclave: il blob opaco e la pubblica x9.63 (65 byte). */
  create: () => Promise<{ key: string; publicKey: Uint8Array }>;
  /** Il segreto condiviso (32 byte) con il punto effimero; chiede il Touch ID con `reason`. */
  ecdh: (key: string, peer: Uint8Array, reason: string) => Promise<Uint8Array>;
  /** Gli appunti coi tipi Concealed/Transient; il `changeCount` per `clearIf`. */
  copy: (text: string) => Promise<number>;
  /** Svuota gli appunti solo se nessuno li ha cambiati dopo `copy`. */
  clearIf: (changeCount: number) => Promise<boolean>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (text: unknown) =>
  typeof text === "string" ? new Uint8Array(Buffer.from(text, "base64")) : null;

export function createKeyHelper(deps: { run: HelperRunner }): KeyHelper {
  async function call(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const raw = await deps.run(JSON.stringify(request));
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error("invalid_response");
    }
    if (!out || typeof out !== "object") throw new Error("invalid_response");
    if (out.ok !== true) throw new Error(typeof out.code === "string" ? out.code : "failed");
    return out;
  }

  return {
    async available() {
      try {
        const out = await call({ cmd: "available" });
        return { secureEnclave: out.secureEnclave === true, biometry: out.biometry === true };
      } catch {
        // Un helper che manca o non risponde: niente enclave.
        return { secureEnclave: false, biometry: false };
      }
    },
    async create() {
      const out = await call({ cmd: "create" });
      const publicKey = unb64(out.publicKey);
      if (typeof out.key !== "string" || out.key === "" || publicKey?.length !== 65)
        throw new Error("invalid_response");
      return { key: out.key, publicKey };
    },
    async ecdh(key, peer, reason) {
      const out = await call({ cmd: "ecdh", key, peer: b64(peer), reason });
      const secret = unb64(out.secret);
      if (secret?.length !== 32) throw new Error("invalid_response");
      return secret;
    },
    async copy(text) {
      const out = await call({ cmd: "copy", text });
      if (typeof out.changeCount !== "number") throw new Error("invalid_response");
      return out.changeCount;
    },
    async clearIf(changeCount) {
      const out = await call({ cmd: "clear-if", changeCount });
      return out.cleared === true;
    },
  };
}

/** Dove sta l'helper nel pacchetto: accanto all'eseguibile dell'app. */
export const helperPath = (exePath: string): string => join(dirname(exePath), "stubwise-keyhelper");

/** L'identifier con cui l'helper è firmato (lo stesso nome del binario). */
export const HELPER_IDENTIFIER = "stubwise-keyhelper";

/**
 * I2 (seconda revisione della cassaforte): il requisito di firma dell'helper —
 * firmato da Apple per il team, con il suo identifier. Senza Team ID (un build
 * non firmato) non c'è requisito: la cassaforte dal desktop resta spenta.
 */
export function helperRequirement(teamId: string): string | null {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) return null;
  return `anchor apple generic and identifier "${HELPER_IDENTIFIER}" and certificate leaf[subject.OU] = "${teamId}"`;
}

/** Verifica dinamica (per pid) con `codesign`: vero solo se il processo soddisfa il requisito. */
export function codesignVerifier(requirement: string): (pid: number) => Promise<boolean> {
  return (pid) =>
    new Promise((resolve) => {
      const child = spawn("/usr/bin/codesign", ["--verify", `-R=${requirement}`, String(pid)], {
        stdio: "ignore",
        env: {},
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
}

/**
 * Avvia l'helper, ne verifica la firma sul processo GIÀ avviato (I2: si
 * controlla il codice che gira, non un file che si potrebbe scambiare dopo)
 * e solo allora gli scrive la richiesta. Verifica fallita o impossibile:
 * l'helper si uccide senza aver ricevuto niente, ed è `unverified`.
 */
export function spawnRunner(
  path: string,
  opts: { verify: (pid: number) => Promise<boolean>; timeoutMs?: number },
): HelperRunner {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"], env: {} });
      let out = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("timeout")));
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (out += chunk));
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", () => finish(() => resolve(out)));
      const pid = child.pid;
      if (pid === undefined) return;
      opts
        .verify(pid)
        .catch(() => false)
        .then((ok) => {
          if (settled) return;
          if (!ok) {
            child.kill("SIGKILL");
            finish(() => reject(new Error("unverified")));
            return;
          }
          child.stdin.end(input);
        });
    });
}
