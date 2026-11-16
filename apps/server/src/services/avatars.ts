import { userAvatars, type Db } from "@stubwise/db";
import { inArray } from "drizzle-orm";

/**
 * Area 9, F1 (D-13; docs/invariants/identity.md): la foto del profilo.
 * Il tipo si DEDUCE dai primi byte: il `Content-Type` dichiarato non conta.
 * PNG, JPEG o WebP soli; mai SVG (è un documento che esegue), mai GIF.
 */
export type AvatarType = "image/png" | "image/jpeg" | "image/webp";
export const AVATAR_MAX_BYTES = 524_288;

export function detectAvatarType(bytes: Buffer): AvatarType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** L'URL della foto di ogni persona che ne ha una (`?v=` cambia a ogni caricamento); MAI i byte. */
export async function avatarUrlsFor(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ userId: userAvatars.userId, updatedAt: userAvatars.updatedAt }).from(userAvatars).where(inArray(userAvatars.userId, ids));
  return new Map(rows.map((r) => [r.userId, `/api/users/${r.userId}/avatar?v=${r.updatedAt.getTime()}`]));
}
