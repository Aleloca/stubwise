import { describe, expect, it } from "vitest";
import { isCrossOriginWrite } from "./same-origin.js";

const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: "stubwise.example.com", ...headers } });

describe("M5: scritture col cookie da un'altra origine", () => {
  it("Sec-Fetch-Site: passa solo same-origin (e none, una navigazione dell'utente); same-site e cross-site no", () => {
    expect(isCrossOriginWrite(req("POST", { "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossOriginWrite(req("POST", { "sec-fetch-site": "none" }))).toBe(false);
    // same-site: un ALTRO sottodominio dello stesso sito, che il cookie Lax non ferma.
    expect(isCrossOriginWrite(req("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossOriginWrite(req("DELETE", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("senza Sec-Fetch-Site decide Origin, confrontato con l'host della richiesta; `null` è un'altra origine", () => {
    expect(isCrossOriginWrite(req("POST", { origin: "https://stubwise.example.com" }))).toBe(false);
    expect(isCrossOriginWrite(req("POST", { origin: "https://evil.example.com" }))).toBe(true);
    expect(isCrossOriginWrite(req("POST", { origin: "null" }))).toBe(true);
    // Dietro caddy l'host vero può arrivare in X-Forwarded-Host.
    expect(isCrossOriginWrite({ method: "POST", headers: { host: "server:3000", "x-forwarded-host": "stubwise.example.com", origin: "https://stubwise.example.com" } })).toBe(false);
  });

  it("le letture non si guardano, e senza nessuno dei due header (un client non browser) passa", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isCrossOriginWrite(req(method, { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isCrossOriginWrite(req("POST", {}))).toBe(false);
  });
});
