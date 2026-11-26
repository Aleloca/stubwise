import { createHash } from "node:crypto";
import { encrypt, serverSshAccess, servers } from "@stubwise/db";
import { serverSshAccessViewSchema, type ServerSshAccessView } from "@stubwise/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import ssh2 from "ssh2";
import { z } from "zod";
import { apiError } from "../errors.js";
import { authErrorResponses, errorSchema } from "./shared.js";

// `ssh2` è CommonJS: sotto l'ESM vero di node espone come export con nome
// solo ciò che `cjs-module-lexer` vede, e `utils` non c'è («Named export
// 'utils' not found», il server non partiva). Si passa dal default.
// Guardia: scripts/check-esm-named-imports.mjs.
const { utils: sshUtils } = ssh2;

/**
 * L'accesso SSH di SOLA LETTURA di un server (area 8, F4b, S7;
 * docs/invariants/server-operations.md). Istanza, `servers.ssh.manage`.
 * - Collegare genera una coppia Ed25519: la privata è cifrata a riposo e la
 *   decifra SOLO il worker; nessuna risposta, log o prompt la porta.
 * - La riga per `authorized_keys` porta `restrict` (niente forward, pty,
 *   agent); il comando crea l'utente SENZA gruppi.
 * - La verifica (worker) fissa la host key e rifiuta un utente con `sudo`,
 *   `wheel`, `docker` o sudo senza password. Rigenerare cambia la coppia e
 *   tiene la host key; revocare cancella la privata.
 * Le correzioni passano dall'agente, MAI da qui: SSH è solo letture.
 */

const USERNAME = "stubwise-read";
const idParamsSchema = z.object({ id: z.uuid() });
// Un nome host o un indirizzo: niente spazi, `;`, e mai un `-` iniziale (un'opzione di ssh).
const hostSchema = z.string().min(1).max(253).regex(/^[A-Za-z0-9][A-Za-z0-9.:-]*$/);
// L'host è facoltativo: senza, l'hostname che l'agente riporta (richiesta del renderer).
const connectBodySchema = z.strictObject({ host: hostSchema.optional(), port: z.number().int().min(1).max(65535).default(22) });
const access = { kind: "instance", permission: "servers.ssh.manage" } as const;

function keyPair() {
  const k = sshUtils.generateKeyPairSync("ed25519", { comment: USERNAME });
  return { publicKey: k.public.trim(), privateKey: k.private };
}

function setupCommand(line: string): string {
  return [
    `sudo useradd --create-home --shell /bin/sh ${USERNAME}`,
    `sudo install -d -m 700 -o ${USERNAME} -g ${USERNAME} /home/${USERNAME}/.ssh`,
    `echo '${line}' | sudo tee /home/${USERNAME}/.ssh/authorized_keys >/dev/null`,
    `sudo chown ${USERNAME}:${USERNAME} /home/${USERNAME}/.ssh/authorized_keys`,
    `sudo chmod 600 /home/${USERNAME}/.ssh/authorized_keys`,
  ].join(" && ");
}

type Row = typeof serverSshAccess.$inferSelect;

function viewOf(row: Row | undefined): ServerSshAccessView {
  if (!row) {
    return {
      status: "none",
      username: USERNAME,
      host: null,
      port: 22,
      publicKey: null,
      authorizedKeysLine: null,
      setupCommand: null,
      verifiedAt: null,
      verifyResult: null,
      canManage: true,
      usable: false,
      fingerprint: null,
      lastUsedAt: null,
      revokedAt: null,
      removeCommand: null,
    };
  }
  const line = row.status === "revoked" ? null : `restrict ${row.publicKey}`;
  return {
    status: row.status,
    username: row.username,
    host: row.host,
    port: row.port,
    publicKey: row.status === "revoked" ? null : row.publicKey,
    authorizedKeysLine: line,
    setupCommand: line ? setupCommand(line) : null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifyResult: row.verifyResult ?? null,
    canManage: true,
    // La stessa regola di `ssh_read` nel worker.
    usable: row.status === "verified" && row.verifyResult?.ok === true && row.hostKey !== null && row.privateKeyEncrypted !== "",
    fingerprint: row.status === "revoked" ? null : fingerprintOf(row.publicKey),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    removeCommand: row.status === "revoked" ? `sudo userdel --remove ${row.username}` : null,
  };
}

/** `SHA256:<base64 senza padding>` della chiave pubblica (`ssh-keygen -lf`). */
function fingerprintOf(publicKey: string): string | null {
  const blob = publicKey.split(/\s+/)[1];
  if (!blob) return null;
  return `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export async function serverSshRoutes(instance: FastifyInstance): Promise<void> {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const response = { 200: serverSshAccessViewSchema, 404: errorSchema, 409: errorSchema, ...authErrorResponses };

  const serverExists = async (id: string) => (await app.db.select({ id: servers.id }).from(servers).where(eq(servers.id, id))).length > 0;
  const rowOf = async (id: string) => (await app.db.select().from(serverSshAccess).where(eq(serverSshAccess.serverId, id)))[0];

  app.get("/:id/ssh", { config: { access }, schema: { params: idParamsSchema, response } }, async (request, reply) => {
    if (!(await serverExists(request.params.id))) return apiError(reply, 404, "not_found", "Server not found");
    return viewOf(await rowOf(request.params.id));
  });

  app.put(
    "/:id/ssh",
    { config: { access }, schema: { params: idParamsSchema, body: connectBodySchema, response: { ...response, 400: errorSchema } } },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await serverExists(id))) return apiError(reply, 404, "not_found", "Server not found");
      const { port } = request.body;
      const host = request.body.host ?? (await app.db.select({ hostname: servers.hostname }).from(servers).where(eq(servers.id, id)))[0]?.hostname ?? null;
      if (!host || !hostSchema.safeParse(host).success) return apiError(reply, 400, "host_required", "The agent has not reported a hostname: give the host");
      const pair = keyPair();
      const values = {
        host,
        port,
        username: USERNAME,
        publicKey: pair.publicKey,
        privateKeyEncrypted: encrypt(pair.privateKey, app.encryptionKey),
        status: "pending" as const,
        // Un host nuovo: la host key si fissa di nuovo alla prima verifica.
        hostKey: null,
        verifiedAt: null,
        verifyResult: null,
        revokedAt: null,
      };
      await app.db.insert(serverSshAccess).values({ serverId: id, ...values }).onConflictDoUpdate({ target: serverSshAccess.serverId, set: values });
      return viewOf(await rowOf(id));
    },
  );

  app.post("/:id/ssh/verify", { config: { access }, schema: { params: idParamsSchema, response } }, async (request, reply) => {
    const row = await rowOf(request.params.id);
    if (!row) return apiError(reply, 404, "not_found", "No SSH access for this server");
    if (row.status === "revoked") return apiError(reply, 409, "revoked", "The SSH access is revoked: connect it again");
    await app.db.update(serverSshAccess).set({ status: "pending", verifyResult: null, verifiedAt: null }).where(eq(serverSshAccess.serverId, row.serverId));
    return viewOf(await rowOf(row.serverId));
  });

  app.post("/:id/ssh/regenerate", { config: { access }, schema: { params: idParamsSchema, response } }, async (request, reply) => {
    const row = await rowOf(request.params.id);
    if (!row) return apiError(reply, 404, "not_found", "No SSH access for this server");
    const pair = keyPair();
    // La host key resta fissata: cambia la NOSTRA coppia, non il server.
    await app.db
      .update(serverSshAccess)
      .set({ publicKey: pair.publicKey, privateKeyEncrypted: encrypt(pair.privateKey, app.encryptionKey), status: "pending", verifyResult: null, verifiedAt: null, revokedAt: null })
      .where(eq(serverSshAccess.serverId, row.serverId));
    return viewOf(await rowOf(row.serverId));
  });

  app.delete("/:id/ssh", { config: { access }, schema: { params: idParamsSchema, response } }, async (request, reply) => {
    const row = await rowOf(request.params.id);
    if (!row) return apiError(reply, 404, "not_found", "No SSH access for this server");
    await app.db
      .update(serverSshAccess)
      .set({ status: "revoked", revokedAt: new Date(), privateKeyEncrypted: "" })
      .where(eq(serverSshAccess.serverId, row.serverId));
    return viewOf(await rowOf(row.serverId));
  });
}
