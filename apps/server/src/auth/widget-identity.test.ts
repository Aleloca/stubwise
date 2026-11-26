import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateWidgetIdentitySecret, verifyWidgetIdentity, WIDGET_IDENTITY_MAX_LIFETIME_S } from "./widget-identity.js";

/**
 * Area 8, «L'API per i siti» (S2): il token d'identità del cliente, firmato
 * dal BACKEND del sito col segreto del widget. Il perimetro è stretto e ogni
 * errore è lo stesso `null` (la rotta ne fa la stessa 401).
 */

const SECRET = generateWidgetIdentitySecret();
const WIDGET = "6a1b4e3c-6f0e-4b1f-9a33-0c9d1e2f3a4b";
const NOW = 1_800_000_000; // secondi
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

function sign(payload: Record<string, unknown>, opts: { header?: unknown; secret?: string; alg?: string } = {}): string {
  const head = b64(opts.header ?? { alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac(opts.alg ?? "sha256", opts.secret ?? SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const good = (over: Record<string, unknown> = {}) => ({ sub: "cliente-42", aud: WIDGET, iat: NOW - 10, exp: NOW + 3600, ...over });
const verify = (token: string, secret = SECRET) => verifyWidgetIdentity(token, { secret, widgetId: WIDGET, nowSeconds: NOW });

describe("verifyWidgetIdentity", () => {
  it("un token giusto dà l'identità (sub, email e nome facoltativi)", () => {
    expect(verify(sign(good({ email: "a@cliente.it", name: "Anna" })))).toEqual({ sub: "cliente-42", email: "a@cliente.it", name: "Anna" });
    expect(verify(sign(good()))).toEqual({ sub: "cliente-42", email: null, name: null });
  });

  it("review finale: `email` e `name` nulli o vuoti sono ASSENTI (le librerie serializzano null), un'email malformata no", () => {
    expect(verify(sign(good({ email: null, name: null })))).toEqual({ sub: "cliente-42", email: null, name: null });
    expect(verify(sign(good({ email: "", name: "" })))).toEqual({ sub: "cliente-42", email: null, name: null });
    expect(verify(sign(good({ email: "non-email" })))).toBeNull();
  });

  it("anche un `typ` assente si accetta (molte librerie lo omettono), ma nient'altro nell'header", () => {
    expect(verify(sign(good(), { header: { alg: "HS256" } }))).not.toBeNull();
    expect(verify(sign(good(), { header: { alg: "HS256", typ: "JWT", kid: "x" } }))).toBeNull();
  });

  it("NEGATIVI della firma e dell'algoritmo", () => {
    expect(verify(sign(good(), { secret: generateWidgetIdentitySecret() }))).toBeNull();
    expect(verify(sign(good()), generateWidgetIdentitySecret())).toBeNull();
    expect(verify(sign(good(), { header: { alg: "none", typ: "JWT" } }).split(".").slice(0, 2).join(".") + ".")).toBeNull();
    expect(verify(sign(good(), { header: { alg: "HS512", typ: "JWT" }, alg: "sha512" }))).toBeNull();
    // L'header deve DIRE HS256: anche con una firma SHA-256 valida, un altro `alg` è rifiutato.
    expect(verify(sign(good(), { header: { alg: "HS384", typ: "JWT" } }))).toBeNull();
    const [h, p] = sign(good()).split(".");
    expect(verify(`${h}.${p}.`)).toBeNull();
    expect(verify(`${h}.${b64(good({ sub: "un-altro" }))}.${sign(good()).split(".")[2]}`)).toBeNull();
  });

  it("NEGATIVI del tempo: exp assente o passato, vita oltre il tetto, iat nel futuro", () => {
    expect(verify(sign({ sub: "x", aud: WIDGET, iat: NOW - 10 }))).toBeNull();
    expect(verify(sign(good({ exp: NOW - 1 })))).toBeNull();
    expect(verify(sign(good({ iat: NOW - 10, exp: NOW - 10 + WIDGET_IDENTITY_MAX_LIFETIME_S + 1 })))).toBeNull();
    expect(verify(sign(good({ iat: NOW - 10, exp: NOW - 10 + WIDGET_IDENTITY_MAX_LIFETIME_S })))).not.toBeNull();
    expect(verify(sign(good({ iat: NOW + 120 })))).toBeNull();
    expect(verify(sign(good({ iat: "ieri" })))).toBeNull();
  });

  it("NEGATIVI del contenuto: aud di un altro widget o assente, sub vuoto o troppo lungo, email non valida, payload enorme, forma rotta", () => {
    expect(verify(sign(good({ aud: "un-altro-widget" })))).toBeNull();
    expect(verify(sign({ sub: "x", iat: NOW, exp: NOW + 60 }))).toBeNull();
    expect(verify(sign(good({ sub: "" })))).toBeNull();
    expect(verify(sign(good({ sub: "x".repeat(201) })))).toBeNull();
    expect(verify(sign(good({ email: "non-email" })))).toBeNull();
    expect(verify(sign(good({ pad: "x".repeat(3000) })))).toBeNull();
    for (const bad of ["", "a.b", "a.b.c.d", "!!!.###.$$$", `${b64("non json")}.${b64(good())}.x`]) expect(verify(bad)).toBeNull();
  });

  it("il segreto generato: 32 byte casuali in base64url, ogni volta diverso", () => {
    const a = generateWidgetIdentitySecret();
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
    expect(a).not.toBe(generateWidgetIdentitySecret());
  });
});
