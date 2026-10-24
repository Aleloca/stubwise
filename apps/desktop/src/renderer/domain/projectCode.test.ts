import { describe, expect, it } from "vitest";
import { proposeProjectCode, validateProjectCode } from "./projectCode";

const none = new Set<string>();

describe("codice di un progetto nuovo", () => {
  it("si propone dalle iniziali: 2–4 maiuscole", () => {
    expect(proposeProjectCode("Brennero Logistics", none)).toBe("BRL");
    expect(proposeProjectCode("Audin", none)).toBe("AUD");
    expect(proposeProjectCode("Campagne primavera Mix Cucine", none)).toBe("CPMC");
    expect(proposeProjectCode("Sito e catalogo Salumificio Altopiano", none)).toBe("SCSA");
    // Accenti e simboli non entrano nel codice.
    expect(proposeProjectCode("Ègida & Ottica", none)).toBe("EGO");
  });

  it("se è già usato ne propone un altro, sempre valido e univoco", () => {
    const taken = new Set(["BRL", "BEL"]);
    const code = proposeProjectCode("Brennero Logistics", taken);
    expect(code).toMatch(/^[A-Z]{2,4}$/);
    expect(taken.has(code!)).toBe(false);
  });

  it("un nome senza lettere non propone nulla", () => {
    expect(proposeProjectCode("  ", none)).toBeNull();
    expect(proposeProjectCode("2026", none)).toBeNull();
  });

  it("valida: obbligatorio, 2–4 lettere maiuscole, non già usato", () => {
    const taken = new Set(["AUD"]);
    expect(validateProjectCode("", taken)).toBe("required");
    expect(validateProjectCode("A", taken)).toBe("format");
    expect(validateProjectCode("ab1", taken)).toBe("format");
    expect(validateProjectCode("ABCDE", taken)).toBe("format");
    expect(validateProjectCode("AUD", taken)).toBe("taken");
    expect(validateProjectCode("BRL", taken)).toBeNull();
  });
});
