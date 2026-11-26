import { and, eq, ne } from "drizzle-orm";
import { Client } from "ssh2";
import { decrypt, serverSshAccess, type Db } from "@stubwise/db";

/**
 * L'SSH di SOLA LETTURA (area 8, F4b, S7; docs/invariants/server-operations.md).
 * - Ogni connessione verifica la host key FISSATA alla prima verifica: una
 *   chiave diversa → nessuna lettura (e l'accesso torna `failed`).
 * - I comandi sono argv FISSI (`SSH_READS`) con parametri solo numerici, citati
 *   uno per uno: niente da interpretare per la shell remota.
 * - La verifica rifiuta un utente con privilegi: `sudo`/`wheel`/`docker`/
 *   `admin`/`root` fra i gruppi, o sudo senza password.
 */

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** `SHA256:<hex>` della host key fissata; null = la si fissa ora (solo nella verifica). */
  hostKey: string | null;
}

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** La host key vista (da fissare se non lo era). */
  hostKey: string;
}

export class SshHostKeyMismatchError extends Error {
  constructor() {
    super("la host key del server è cambiata: nessuna lettura");
    this.name = "SshHostKeyMismatchError";
  }
}

export type SshExec = (target: SshTarget, argv: readonly string[], opts?: { timeoutMs?: number }) => Promise<SshExecResult>;

const quote = (a: string) => `'${a.replaceAll("'", `'\\''`)}'`;
const MAX_CAPTURE = 64 * 1024;

/** Un comando (argv fisso) su una connessione nuova, con la host key fissata. */
export const sshExec: SshExec = (target, argv, opts = {}) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    let seenKey = "";
    let mismatch = false;
    const timer = setTimeout(() => {
      conn.end();
      reject(new Error("ssh: tempo scaduto"));
    }, opts.timeoutMs ?? 20_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    conn
      .on("ready", () => {
        conn.exec(argv.map(quote).join(" "), (err, stream) => {
          if (err) {
            conn.end();
            return done(() => reject(err));
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", (d: Buffer) => {
            if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
          });
          stream.stderr.on("data", (d: Buffer) => {
            if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
          });
          stream.on("close", (code: number | null) => {
            conn.end();
            done(() => resolve({ exitCode: code ?? -1, stdout, stderr, hostKey: seenKey }));
          });
        });
      })
      .on("error", (err) => done(() => reject(mismatch ? new SshHostKeyMismatchError() : err)))
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: opts.timeoutMs ?? 20_000,
        hostHash: "sha256",
        hostVerifier: (hash: string) => {
          seenKey = `SHA256:${hash}`;
          if (target.hostKey !== null && target.hostKey !== seenKey) {
            mismatch = true;
            return false;
          }
          return true;
        },
        // Niente agent, niente forward: questa connessione legge e basta.
        agent: undefined,
        agentForward: false,
      });
  });

// `lxd`/`lxc`/`disk` valgono root quanto `docker` (review F4b).
const PRIVILEGED_GROUPS = new Set(["sudo", "wheel", "docker", "admin", "root", "lxd", "lxc", "disk"]);
const JOURNAL_GROUPS = new Set(["systemd-journal", "adm"]);

export function judgeSshUser(groups: readonly string[], sudoWithoutPassword: boolean) {
  const docker = groups.includes("docker");
  return {
    groups: [...groups],
    sudo: sudoWithoutPassword,
    docker,
    journal: groups.some((g) => JOURNAL_GROUPS.has(g)),
    ok: !sudoWithoutPassword && !groups.some((g) => PRIVILEGED_GROUPS.has(g)),
  };
}

/** La verifica degli accessi in attesa: fissa la host key, legge gruppi e sudo, decide. */
export async function verifyPendingSshAccess(db: Db, encryptionKey: Buffer, exec: SshExec = sshExec, log: (m: string) => void = console.warn): Promise<void> {
  const rows = await db
    .select()
    .from(serverSshAccess)
    .where(and(eq(serverSshAccess.status, "pending"), ne(serverSshAccess.privateKeyEncrypted, "")));
  for (const row of rows) {
    const target: SshTarget = { host: row.host, port: row.port, username: row.username, privateKey: decrypt(row.privateKeyEncrypted, encryptionKey), hostKey: row.hostKey };
    try {
      const id = await exec(target, ["id", "-Gn"]);
      if (id.exitCode !== 0) throw new Error(`id -Gn: uscita ${id.exitCode}`);
      // `sudo -n -l` riesce con QUALUNQUE regola senza password, anche limitata a
      // un comando (review F4b): `sudo -n true` vedeva solo quella generale.
      const sudo = await exec({ ...target, hostKey: id.hostKey }, ["sudo", "-n", "-l"]);
      const result = judgeSshUser(id.stdout.trim().split(/\s+/).filter(Boolean), sudo.exitCode === 0);
      await db
        .update(serverSshAccess)
        .set({ status: result.ok ? "verified" : "failed", verifyResult: result, hostKey: id.hostKey, verifiedAt: new Date() })
        .where(and(eq(serverSshAccess.serverId, row.serverId), eq(serverSshAccess.status, "pending")));
    } catch (error) {
      log(`[server-ops] verifica SSH del server ${row.serverId} fallita: ${error instanceof Error ? error.message : String(error)}`);
      await db
        .update(serverSshAccess)
        .set({ status: "failed", verifiedAt: new Date() })
        .where(and(eq(serverSshAccess.serverId, row.serverId), eq(serverSshAccess.status, "pending")));
    }
  }
}
