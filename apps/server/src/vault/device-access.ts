import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { vaultDeviceSeals, type Db } from "@stubwise/db";
import { isDesktopPat } from "../auth/access.js";
import { apiError } from "../errors.js";
import { liveSealCondition } from "./device-seals.js";

/**
 * LA regola di chi entra in una rotta della cassaforte (lotto 10, D-7,
 * `docs/plans/2026-11-24-cassaforte-desktop-design.md` §6.3), in UN posto:
 *
 * - una sessione del browser, come sempre;
 * - il PAT `desktop` SOLO su una rotta che lo dichiara
 *   (`config.desktopVault`, elenco chiuso in `route-access.test.ts`) e SOLO
 *   con un sigillo VIVO legato a quel PAT: non revocato, della persona, con la
 *   chiave di persona ancora quella confermata (la revoca vale a LETTURA,
 *   ogni richiesta). Senza: 403 `device_seal_required`, e il desktop propone
 *   di associare il Mac;
 * - ogni altro PAT (`manual`, `mobile`) e il desktop sulle rotte non
 *   dichiarate: 403 `session_required`, come prima;
 * - con l'interruttore `VAULT_DESKTOP` spento (il default) il PAT desktop
 *   riceve 404 `not_found` sulle rotte dichiarate, come se non ci fossero.
 */
export type VaultCaller = { via: "session" } | { via: "desktop"; sealId: string };

export async function vaultCallerOf(
  db: Db,
  request: FastifyRequest,
): Promise<{ ok: true; caller: VaultCaller } | { ok: false; code: "session_required" | "device_seal_required" | "not_found" }> {
  const user = request.user!;
  if (user.patId === undefined) {
    return user.sessionId !== undefined ? { ok: true, caller: { via: "session" } } : { ok: false, code: "session_required" };
  }
  if (!isDesktopPat(user) || request.routeOptions.config?.desktopVault !== true) {
    return { ok: false, code: "session_required" };
  }
  // L'interruttore d'istanza (`VAULT_DESKTOP`, spento di default): spento, per
  // il Mac queste rotte non ci sono.
  if (request.server.vaultDesktop !== true) return { ok: false, code: "not_found" };
  const [seal] = await db
    .select({ id: vaultDeviceSeals.id })
    .from(vaultDeviceSeals)
    .where(and(eq(vaultDeviceSeals.patId, user.patId), eq(vaultDeviceSeals.userId, user.id), liveSealCondition()));
  return seal ? { ok: true, caller: { via: "desktop", sealId: seal.id } } : { ok: false, code: "device_seal_required" };
}

/** {@link vaultCallerOf} con la risposta: `null` = la 403 è già partita. */
export async function requireVaultCaller(db: Db, request: FastifyRequest, reply: FastifyReply): Promise<VaultCaller | null> {
  const verdict = await vaultCallerOf(db, request);
  if (verdict.ok) return verdict.caller;
  if (verdict.code === "not_found") {
    await apiError(reply, 404, "not_found", "Not found");
  } else if (verdict.code === "device_seal_required") {
    await apiError(reply, 403, "device_seal_required", "Pair this Mac with your vault from the browser first");
  } else {
    await apiError(reply, 403, "session_required", "This action requires a browser session");
  }
  return null;
}
