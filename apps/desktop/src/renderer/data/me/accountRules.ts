// Le regole dei campi dell'account (password, email), senza stato: `account.ts` le ri-esporta.

export const MIN_PASSWORD_LENGTH = 8;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Il limite della foto, come sul server (design area 9, 1.6). */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * Perché una foto non va, o `null` se va (design area 9, 1.6, come
 * `PUT /api/me/avatar`): il TIPO si deduce dai primi byte, PNG, JPEG o WebP
 * soli; quello dichiarato nel data URL non conta. Mai SVG, mai GIF.
 */
export function avatarRefusal(dataUrl: string): "avatar_type" | "avatar_size" | null {
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl);
  if (!m) return "avatar_type";
  let bytes: string;
  try {
    bytes = atob(m[1]!);
  } catch {
    return "avatar_type";
  }
  const png = bytes.startsWith("\x89PNG\r\n\x1a\n");
  const jpeg = bytes.startsWith("\xff\xd8\xff");
  const webp = bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  if (!png && !jpeg && !webp) return "avatar_type";
  return bytes.length > AVATAR_MAX_BYTES ? "avatar_size" : null;
}
