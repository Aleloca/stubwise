import { describe, expect, it } from "vitest";
import {
  googleOauthScopes,
  googleWorkspaceDraftSchema,
  googleWorkspacePatchSchema,
  googleWorkspaceSchema,
} from "./google.js";

describe("googleWorkspaceDraftSchema", () => {
  const base = {
    name: "Acme",
    domains: ["Acme.COM"],
    clientId: "123.apps.googleusercontent.com",
    clientSecret: "GOCSPX-segreto",
  };

  it("normalizza i domini in lowercase e li ripulisce dagli spazi", () => {
    const parsed = googleWorkspaceDraftSchema.parse({
      ...base,
      domains: ["  Acme.COM ", "Sub.Acme.Example"],
    });
    expect(parsed.domains).toEqual(["acme.com", "sub.acme.example"]);
  });

  it("deduplica i domini che collassano sulla stessa forma normalizzata", () => {
    const parsed = googleWorkspaceDraftSchema.parse({
      ...base,
      domains: ["acme.com", "ACME.com", " acme.com "],
    });
    expect(parsed.domains).toEqual(["acme.com"]);
  });

  it("rifiuta un elenco di domini vuoto", () => {
    expect(googleWorkspaceDraftSchema.safeParse({ ...base, domains: [] }).success).toBe(false);
  });

  it("rifiuta un dominio che contiene una chiocciola (è un indirizzo, non un dominio)", () => {
    expect(
      googleWorkspaceDraftSchema.safeParse({ ...base, domains: ["mario@acme.com"] }).success,
    ).toBe(false);
  });

  it("rifiuta un dominio con spazi interni", () => {
    expect(
      googleWorkspaceDraftSchema.safeParse({ ...base, domains: ["acme com"] }).success,
    ).toBe(false);
  });

  it("rifiuta un dominio senza punto (un Workspace ha sempre un dominio pieno)", () => {
    expect(googleWorkspaceDraftSchema.safeParse({ ...base, domains: ["acme"] }).success).toBe(
      false,
    );
  });

  it("richiede un client secret non vuoto in creazione", () => {
    expect(googleWorkspaceDraftSchema.safeParse({ ...base, clientSecret: "" }).success).toBe(false);
    expect(
      googleWorkspaceDraftSchema.safeParse({ ...base, clientSecret: undefined }).success,
    ).toBe(false);
  });

  it("richiede un nome non vuoto", () => {
    expect(googleWorkspaceDraftSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });
});

describe("googleWorkspacePatchSchema", () => {
  it("distingue il client secret ASSENTE (invariato) dalla stringa vuota (azzera)", () => {
    const absent = googleWorkspacePatchSchema.parse({ name: "Acme" });
    expect("clientSecret" in absent && absent.clientSecret !== undefined).toBe(false);

    const cleared = googleWorkspacePatchSchema.parse({ clientSecret: "" });
    expect(cleared.clientSecret).toBe("");
  });

  it("accetta una patch vuota (nessun campo tocca nulla)", () => {
    expect(googleWorkspacePatchSchema.parse({})).toEqual({});
  });

  it("normalizza i domini anche in patch", () => {
    const parsed = googleWorkspacePatchSchema.parse({ domains: ["ACME.com"] });
    expect(parsed.domains).toEqual(["acme.com"]);
  });

  it("rifiuta un elenco di domini vuoto anche in patch", () => {
    expect(googleWorkspacePatchSchema.safeParse({ domains: [] }).success).toBe(false);
  });
});

describe("googleWorkspaceSchema", () => {
  it("espone solo il flag del segreto, mai il segreto", () => {
    const parsed = googleWorkspaceSchema.parse({
      id: "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11",
      name: "Acme",
      domains: ["acme.com"],
      clientId: "123.apps.googleusercontent.com",
      clientSecretSet: true,
      accountCount: 2,
      redirectUri: "https://stubwise.example.com/api/me/google/callback",
      createdAt: "2026-09-07T10:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("clientSecret");
    expect(parsed.clientSecretSet).toBe(true);
  });

  it("`accountCount` ha un default: una risposta senza il campo resta parsabile", () => {
    const parsed = googleWorkspaceSchema.parse({
      id: "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11",
      name: "Acme",
      domains: ["acme.com"],
      clientId: "123.apps.googleusercontent.com",
      clientSecretSet: false,
      redirectUri: "https://stubwise.example.com/api/me/google/callback",
      createdAt: "2026-09-07T10:00:00.000Z",
    });
    expect(parsed.accountCount).toBe(0);
  });
});

describe("googleOauthScopes", () => {
  it("è la lista minima di sola lettura mostrata all'admin e usata dal consenso", () => {
    expect(googleOauthScopes).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });
});
