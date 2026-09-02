import { describe, expect, it } from "vitest";
import { mobileLoginBodySchema } from "./pat.js";

/** Corpo valido a cui i casi cambiano solo il `deviceName`. */
function parse(deviceName: string) {
  return mobileLoginBodySchema.safeParse({
    email: "ada@example.com",
    password: "password-sicura",
    deviceName,
  });
}

/**
 * Il nome del device e' l'unica parte del PAT scritta da chi si autentica, ed
 * e' quella su cui un umano decide quale device revocare. Questi casi sono la
 * regressione di un errore vero: vietare `\p{Cf}` in blocco sembrava la
 * difesa ovvia e invece rifiutava le emoji composte (ZWJ) e le lingue che
 * usano lo ZWNJ, mentre lasciava passare U+2028 — cioe' proprio una
 * interruzione di riga, la classe da cui doveva difendere.
 */
describe("mobileLoginBodySchema — deviceName", () => {
  it.each([
    ["emoji composta con ZWJ (U+200D)", "iPhone di \u{1F468}\u200D\u{1F4BB}"],
    ["bandiera arcobaleno (ZWJ)", "\u{1F3F3}️\u200D\u{1F308} phone"],
    ["famiglia (ZWJ x2)", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["persiano con ZWNJ (U+200C)", "می\u200Cخواهم"],
    ["soft hyphen (U+00AD)", "Tele\u00ADfono"],
    ["emoji semplice", "\u{1F4F1} di Ada"],
    ["accenti", "iPhone di Zoë"],
    ["giapponese", "田中のiPhone"],
    ["80 caratteri esatti", "x".repeat(80)],
  ])("accetta un nome legittimo: %s", (_nome, deviceName) => {
    expect(parse(deviceName).success).toBe(true);
  });

  it.each([
    ["newline", "iPhone\nAdmin"],
    ["carriage return", "iPhone\rAdmin"],
    ["tab", "iPhone\tAdmin"],
    ["LINE SEPARATOR U+2028 (Zl, fuori da Cc)", "iPhone\u2028Admin"],
    ["PARAGRAPH SEPARATOR U+2029 (Zp, fuori da Cc)", "iPhone\u2029Admin"],
    ["override bidi RLO U+202E", "iPhone\u202Eoff"],
    ["mark bidi RLM U+200F", "iPhone\u200F"],
    ["mark bidi LRM U+200E", "iPhone\u200E"],
    ["isolate bidi LRI U+2066", "iPhone\u2066"],
    ["isolate bidi PDI U+2069", "iPhone\u2069"],
    ["arabic letter mark U+061C", "iPhone\u061C"],
    ["vuoto", ""],
    ["soli spazi", "   "],
    ["81 caratteri", "x".repeat(81)],
  ])("rifiuta: %s", (_nome, deviceName) => {
    expect(parse(deviceName).success).toBe(false);
  });

  it("trimma prima dei vincoli, cosi' il nome del PAT non porta spazi", () => {
    const parsed = parse("  iPhone di Ada  ");
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.deviceName).toBe("iPhone di Ada");
  });

  it("il trim viene PRIMA del max: 80 caratteri fra spazi passano", () => {
    // Se il max girasse sulla stringa non trimmata, questo sarebbe un 400.
    expect(parse(`  ${"x".repeat(80)}  `).success).toBe(true);
  });
});
