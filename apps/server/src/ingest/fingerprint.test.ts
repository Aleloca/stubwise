import { describe, expect, it } from "vitest";
import { fingerprint } from "./fingerprint.js";

const HEX_64 = /^[0-9a-f]{64}$/;

describe("fingerprint", () => {
  it("restituisce un hash sha256 esadecimale", () => {
    const fp = fingerprint({ errorType: "TypeError", message: "x is undefined" });
    expect(fp).toMatch(HEX_64);
  });

  it("stesso errore da release diverse → stesso fingerprint", () => {
    const a = fingerprint({
      errorType: "TypeError",
      message: "x is undefined",
      stack:
        "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)",
    });
    const b = fingerprint({
      errorType: "TypeError",
      message: "x is undefined",
      stack:
        "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-d4e5f6.js:99:1)",
    });
    expect(a).toBe(b);
  });

  it("errori con tipo diverso → fingerprint diverso", () => {
    const stack = "  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)";
    const a = fingerprint({ errorType: "TypeError", message: "boom", stack });
    const b = fingerprint({ errorType: "RangeError", message: "boom", stack });
    expect(a).not.toBe(b);
  });

  it("stack diversi → fingerprint diverso", () => {
    const a = fingerprint({
      errorType: "TypeError",
      message: "boom",
      stack: "  at buy (https://cdn.app/assets/checkout.js:10:5)",
    });
    const b = fingerprint({
      errorType: "TypeError",
      message: "boom",
      stack: "  at login (https://cdn.app/assets/auth.js:3:1)",
    });
    expect(a).not.toBe(b);
  });

  it("messaggi con valori dinamici vengono normalizzati", () => {
    const a = fingerprint({ errorType: "Error", message: "User 12345 not found" });
    const b = fingerprint({ errorType: "Error", message: "User 67890 not found" });
    expect(a).toBe(b);
  });

  it("uuid diversi nel messaggio → stesso fingerprint", () => {
    const a = fingerprint({
      message: "order 7f9c24e8-3b2a-4f0e-9c1d-2a6b8d4e5f01 failed",
    });
    const b = fingerprint({
      message: "order 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9 failed",
    });
    expect(a).toBe(b);
  });

  it("stringhe quotate (singole e doppie) vengono normalizzate", () => {
    const a = fingerprint({ message: `Cannot read property "foo" of 'bar'` });
    const b = fingerprint({ message: `Cannot read property "baz" of 'qux'` });
    expect(a).toBe(b);
  });

  it("id esadecimali lunghi vengono normalizzati", () => {
    const a = fingerprint({ message: "commit 9f8e7d6c5b4a3210 not found" });
    const b = fingerprint({ message: "commit 0123456789abcdef not found" });
    expect(a).toBe(b);
  });

  it("messaggi davvero diversi → fingerprint diverso", () => {
    const a = fingerprint({ message: "user not found" });
    const b = fingerprint({ message: "payment declined" });
    expect(a).not.toBe(b);
  });

  it("senza stack usa tipo+messaggio normalizzato", () => {
    const a = fingerprint({ errorType: "Error", message: "User 1 not found" });
    const b = fingerprint({ errorType: "Error", message: "User 2 not found" });
    const c = fingerprint({ errorType: "TypeError", message: "User 1 not found" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("senza errorType non esplode e distingue per messaggio", () => {
    const a = fingerprint({ message: "boom" });
    const b = fingerprint({ message: "crash" });
    expect(a).toMatch(HEX_64);
    expect(a).not.toBe(b);
  });

  it("stack vuoto equivale a nessuno stack", () => {
    const a = fingerprint({ errorType: "Error", message: "boom", stack: "" });
    const b = fingerprint({ errorType: "Error", message: "boom" });
    expect(a).toBe(b);
  });

  it("stack senza frame riconoscibili ricade su tipo+messaggio", () => {
    const a = fingerprint({
      errorType: "Error",
      message: "User 1 not found",
      stack: "Error: User 1 not found",
    });
    const b = fingerprint({ errorType: "Error", message: "User 2 not found" });
    expect(a).toBe(b);
  });

  it("stile Firefox (fn@url:line:col) produce lo stesso fingerprint dello stile Chrome", () => {
    const chrome = fingerprint({
      errorType: "TypeError",
      message: "x is undefined",
      stack:
        "TypeError: x is undefined\n  at buy (https://cdn.app/assets/app-a1b2c3.js:10:5)\n  at run (https://cdn.app/assets/main-ff00aa.js:1:1)",
    });
    const firefox = fingerprint({
      errorType: "TypeError",
      message: "x is undefined",
      stack:
        "buy@https://cdn.app/assets/app-d4e5f6.js:99:1\nrun@https://cdn.app/assets/main-bb11cc.js:7:3",
    });
    expect(chrome).toBe(firefox);
  });

  it("frame anonimi (at url:line:col e @url:line:col) sono gestiti", () => {
    const chrome = fingerprint({
      errorType: "Error",
      message: "boom",
      stack: "Error: boom\n  at https://cdn.app/assets/app-a1b2c3.js:10:5",
    });
    const firefox = fingerprint({
      errorType: "Error",
      message: "boom",
      stack: "@https://cdn.app/assets/app-d4e5f6.js:99:1",
    });
    expect(chrome).toBe(firefox);
  });

  it("considera solo i primi 8 frame: il nono diverso non cambia il fingerprint", () => {
    const frames = (ninth: string) =>
      [
        ...Array.from({ length: 8 }, (_, i) => `  at fn${i} (https://app/x.js:${i}:1)`),
        ninth,
      ].join("\n");
    const a = fingerprint({
      errorType: "Error",
      message: "boom",
      stack: `Error: boom\n${frames("  at extra (https://app/y.js:1:1)")}`,
    });
    const b = fingerprint({
      errorType: "Error",
      message: "boom",
      stack: `Error: boom\n${frames("  at other (https://app/z.js:2:2)")}`,
    });
    expect(a).toBe(b);
  });

  it("l'ottavo frame diverso cambia invece il fingerprint", () => {
    const frames = (eighth: string) =>
      [
        ...Array.from({ length: 7 }, (_, i) => `  at fn${i} (https://app/x.js:${i}:1)`),
        eighth,
      ].join("\n");
    const a = fingerprint({
      message: "boom",
      stack: frames("  at extra (https://app/y.js:1:1)"),
    });
    const b = fingerprint({
      message: "boom",
      stack: frames("  at other (https://app/z.js:2:2)"),
    });
    expect(a).not.toBe(b);
  });

  it("strippa varianti di hash di build nel basename", () => {
    const variants = [
      "https://cdn.app/assets/chunk-vendors-a1b2c3d4.js:1:1",
      "https://cdn.app/assets/chunk-vendors-ZZ99aa88.js:9:9",
      "https://other.cdn/static/chunk-vendors-deadbeef00.js:3:7",
    ];
    const fps = variants.map((url) =>
      fingerprint({ errorType: "Error", message: "boom", stack: `  at run (${url})` }),
    );
    expect(fps[1]).toBe(fps[0]);
    expect(fps[2]).toBe(fps[0]);
  });

  it("un suffisso corto (non hash) nel basename NON viene strippato", () => {
    const a = fingerprint({
      message: "boom",
      stack: "  at run (https://app/utils-v2.js:1:1)",
    });
    const b = fingerprint({
      message: "boom",
      stack: "  at run (https://app/utils.js:1:1)",
    });
    expect(a).not.toBe(b);
  });

  it("ignora querystring e numeri di riga/colonna nel confronto dei frame", () => {
    const a = fingerprint({
      message: "boom",
      stack: "  at run (https://app/main.js?v=123:10:5)",
    });
    const b = fingerprint({
      message: "boom",
      stack: "  at run (https://app/main.js:99:42)",
    });
    expect(a).toBe(b);
  });
});
