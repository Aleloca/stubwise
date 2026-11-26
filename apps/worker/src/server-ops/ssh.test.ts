import type { AddressInfo } from "node:net";
import ssh2, { type Server as SshServer } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeSshUser, sshExec, SshHostKeyMismatchError, type SshTarget } from "./ssh.js";

// CommonJS: sotto l'ESM vero `Server` e `utils` non sono export con nome (vedi apps/server/src/routes/server-ssh.ts).
const { Server, utils } = ssh2;

/**
 * Area 8, F4b, S7: l'esecuzione SSH contro un server SSH VERO su loopback
 * (ssh2): la host key fissata, gli argv citati, il giudizio sull'utente.
 */

const hostKey = utils.generateKeyPairSync("ed25519").private;
const clientKey = utils.generateKeyPairSync("ed25519").private;
const commands: string[] = [];
let server: SshServer;
let port = 0;

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on("authentication", (ctx) => (ctx.method === "publickey" ? ctx.accept() : ctx.reject(["publickey"])))
      .on("ready", () => {
        client.on("session", (accept) => {
          accept().once("exec", (acceptExec, _reject, info) => {
            commands.push(info.command);
            const stream = acceptExec();
            stream.write(info.command === "'id' '-Gn'" ? "stubwise-read adm\n" : "ok\n");
            stream.exit(0);
            stream.end();
          });
        });
      })
      .on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const target = (pinned: string | null): SshTarget => ({ host: "127.0.0.1", port, username: "stubwise-read", privateKey: clientKey, hostKey: pinned });

describe("sshExec", () => {
  it("la prima volta restituisce la host key da fissare; con quella giusta legge; gli argv arrivano citati", async () => {
    const first = await sshExec(target(null), ["id", "-Gn"]);
    expect(first).toMatchObject({ exitCode: 0, stdout: "stubwise-read adm\n" });
    expect(first.hostKey).toMatch(/^SHA256:[0-9a-f]{64}$/);
    const again = await sshExec(target(first.hostKey), ["ps", "-eo", "pid,comm"]);
    expect(again.exitCode).toBe(0);
    expect(commands).toContain("'ps' '-eo' 'pid,comm'");
  });

  it("NEGATIVO: una host key diversa da quella fissata → nessun comando eseguito", async () => {
    const before = commands.length;
    await expect(sshExec(target(`SHA256:${"0".repeat(64)}`), ["df", "-P"])).rejects.toBeInstanceOf(SshHostKeyMismatchError);
    expect(commands.length).toBe(before);
  });

  it("un argomento con un apice non esce dalla citazione", async () => {
    const first = await sshExec(target(null), ["echo", "a'; rm -rf /; '"]);
    expect(first.exitCode).toBe(0);
    expect(commands.at(-1)).toBe(`'echo' 'a'\\''; rm -rf /; '\\'''`);
  });
});

describe("judgeSshUser", () => {
  it("privilegi → non usabile; il gruppo del journal → leggibile", () => {
    expect(judgeSshUser(["stubwise-read"], false)).toMatchObject({ ok: true, journal: false, docker: false });
    expect(judgeSshUser(["stubwise-read", "adm"], false)).toMatchObject({ ok: true, journal: true });
    expect(judgeSshUser(["stubwise-read", "systemd-journal"], false)).toMatchObject({ ok: true, journal: true });
    for (const g of ["sudo", "wheel", "docker", "admin", "root", "lxd", "lxc", "disk"]) expect(judgeSshUser(["stubwise-read", g], false).ok).toBe(false);
    expect(judgeSshUser(["stubwise-read"], true)).toMatchObject({ ok: false, sudo: true });
  });
});
