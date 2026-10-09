import { describe, expect, it } from "vitest";
import { REDACTED, createRedactor } from "./redact.js";

describe("createRedactor", () => {
  it("oscura un valore ovunque compaia, anche annidato in oggetti e array", () => {
    const r = createRedactor(["s3cr3t-token"]);
    expect(
      r({ content: "TOKEN=s3cr3t-token\nother", list: ["a s3cr3t-token b"], n: 3, ok: true }),
    ).toEqual({ content: `TOKEN=${REDACTED}\nother`, list: [`a ${REDACTED} b`], n: 3, ok: true });
  });

  it("ignora i valori corti (sotto MIN_SECRET_LENGTH) per non oscurare 'true' o '1'", () => {
    const r = createRedactor(["true", "1", "abc"]);
    expect(r("true 1 abc")).toBe("true 1 abc");
  });

  it("oscura prima il valore più lungo quando uno contiene l'altro", () => {
    const r = createRedactor(["abcdefgh", "abcdefgh-ijkl"]);
    expect(r("x abcdefgh-ijkl y")).toBe(`x ${REDACTED} y`);
  });

  it("senza segreti è l'identità", () => {
    const value = { a: "b" };
    expect(createRedactor([])(value)).toBe(value);
  });

  it("i caratteri speciali di regex nel valore non rompono niente", () => {
    const r = createRedactor(["p@ss(w0rd)+$"]);
    expect(r("x p@ss(w0rd)+$ y")).toBe(`x ${REDACTED} y`);
  });
});
