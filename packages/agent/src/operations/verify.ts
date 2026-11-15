import { createPublicKey, verify as verifySignature } from "node:crypto";
import { serverActionKind, canonicalCommandPayload, serverActionSchema, type ServerAction, type ServerCommandPayload } from "@stubwise/shared";

/**
 * Area 8, F4b: the agent's gate. A command runs ONLY if it is signed by the
 * Stubwise instance key that was PINNED at install time
 * (`STUBWISE_COMMAND_PUBLIC_KEY`, never fetched from the server), is for THIS
 * server, has not expired, has a nonce never seen, is an action of the closed
 * set with strict params, and names a container the agent itself sees.
 * Anything else is refused before the Docker socket is touched.
 * Rules: docs/invariants/server-operations.md.
 */

export interface SignedCommand {
  payload: ServerCommandPayload;
  signature: string;
}

export interface NonceStore {
  has(id: string): boolean;
  add(id: string, expiresAt: string): void;
}

export type VerifyResult =
  | { ok: true; commandId: string; action: ServerAction }
  | { ok: false; commandId: string | null; reason: "bad_signature" | "other_server" | "expired" | "replayed" | "bad_action" | "unknown_container" | "malformed" };

export interface VerifyContext {
  /** The pinned instance public key (SPKI DER, base64). */
  publicKey: string;
  /** This server's id, pinned from the first config; null = not known yet → refuse. */
  serverId: string | null;
  now: Date;
  nonces: NonceStore;
  /** The containers the agent currently reports. */
  seenContainers: readonly string[];
}

export function verifyCommand(cmd: SignedCommand, ctx: VerifyContext): VerifyResult {
  const id = typeof cmd?.payload?.commandId === "string" ? cmd.payload.commandId : null;
  if (!cmd || typeof cmd.signature !== "string" || !cmd.payload || cmd.payload.v !== 1) return { ok: false, commandId: id, reason: "malformed" };
  let valid = false;
  try {
    const key = createPublicKey({ key: Buffer.from(ctx.publicKey, "base64"), format: "der", type: "spki" });
    valid = verifySignature(null, Buffer.from(canonicalCommandPayload(cmd.payload)), key, Buffer.from(cmd.signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, commandId: id, reason: "bad_signature" };
  if (ctx.serverId === null || cmd.payload.serverId !== ctx.serverId) return { ok: false, commandId: id, reason: "other_server" };
  const expires = Date.parse(cmd.payload.expiresAt);
  if (Number.isNaN(expires) || expires <= ctx.now.getTime()) return { ok: false, commandId: id, reason: "expired" };
  if (ctx.nonces.has(cmd.payload.commandId)) return { ok: false, commandId: id, reason: "replayed" };
  const parsed = serverActionSchema.safeParse({ action: cmd.payload.action, params: cmd.payload.params });
  if (!parsed.success) return { ok: false, commandId: id, reason: "bad_action" };
  // Review F4b (difesa in profondità): un'azione che CAMBIA arriva sempre con la sua approvazione.
  if (serverActionKind(parsed.data.action) === "change" && (typeof cmd.payload.approvalId !== "string" || cmd.payload.approvalId === "")) {
    return { ok: false, commandId: id, reason: "bad_action" };
  }
  const container = (parsed.data.params as { container?: string }).container;
  if (container !== undefined && !ctx.seenContainers.includes(container)) return { ok: false, commandId: id, reason: "unknown_container" };
  // The nonce is spent BEFORE running: a crash mid-run never replays it.
  ctx.nonces.add(cmd.payload.commandId, cmd.payload.expiresAt);
  // Validated by the strict schema of the closed set: the correlated type holds.
  return { ok: true, commandId: cmd.payload.commandId, action: parsed.data as ServerAction };
}
