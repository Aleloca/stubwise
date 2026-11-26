import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Area 8, «L'API per i siti» (S2; piano
 * docs/plans/2026-11-15-integrazione-area8-api-siti-plan.md): il token
 * d'identità del cliente che il BACKEND del sito firma col segreto
 * d'identità del widget. JWT compatto HS256, verificato a mano: il perimetro è
 * stretto apposta.
 * - L'header è esattamente `{"alg":"HS256"}` (più `typ: "JWT"`): niente
 *   `none`, niente confusione di algoritmo, niente `kid`.
 * - La firma si confronta a tempo costante.
 * - `exp` è obbligatorio, `exp − iat` è al più 24 ore (D-6), e `iat` non è
 *   più di 60 secondi nel futuro.
 * - `aud` è l'id del widget: un token di un widget non vale su un altro.
 * - `sub` ha 1–200 caratteri, come `external_user_id`.
 * Qualunque errore è lo stesso `null`: la rotta ne fa la stessa 401, nessun
 * oracolo su quale controllo è caduto.
 */

export const WIDGET_IDENTITY_MAX_LIFETIME_S = 24 * 3600;
const CLOCK_SKEW_S = 60;
const MAX_TOKEN_CHARS = 2048;

export interface WidgetIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

const headerSchema = z.strictObject({ alg: z.literal("HS256"), typ: z.literal("JWT").optional() });
const payloadSchema = z.object({
  sub: z.string().min(1).max(200),
  aud: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  // null o "" = assente (molte librerie serializzano un campo vuoto così);
  // un'email malformata resta un errore di chi firma.
  email: z.union([z.literal(""), z.email().max(320)]).nullable().optional(),
  name: z.string().max(200).nullable().optional(),
});

/** 32 byte casuali, base64url: il segreto d'identità di un widget. */
export function generateWidgetIdentitySecret(): string {
  return randomBytes(32).toString("base64url");
}

function decodeJson(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function verifyWidgetIdentity(token: string, input: { secret: string; widgetId: string; nowSeconds?: number }): WidgetIdentity | null {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  if (!headerSchema.safeParse(decodeJson(head)).success) return null;
  const expected = createHmac("sha256", input.secret).update(`${head}.${body}`).digest();
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = payloadSchema.safeParse(decodeJson(body));
  if (!payload.success) return null;
  const p = payload.data;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (p.aud !== input.widgetId) return null;
  if (p.exp <= now) return null;
  if (p.iat > now + CLOCK_SKEW_S) return null;
  if (p.exp - p.iat > WIDGET_IDENTITY_MAX_LIFETIME_S) return null;
  return { sub: p.sub, email: p.email || null, name: p.name?.trim() || null };
}
