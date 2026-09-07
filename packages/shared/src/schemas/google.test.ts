import { describe, expect, it } from "vitest";
import {
  emailLabelsSchema,
  emailRouteSchema,
  emailRoutesPutSchema,
  emailRoutesSchema,
  googleAccountSchema,
  googleCallbackOutcomes,
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

describe("googleAccountSchema", () => {
  const full = {
    id: "6b1f3c2a-1f4d-4c9a-9a3e-9b5f0d2c7e31",
    email: "mario@acme.com",
    workspaceId: "0f2c6d6e-6e4a-4d9b-9d6a-2f5b4c8e1a11",
    workspaceName: "Acme",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
    proposalsEnabled: true,
    connectedAt: "2026-09-07T10:00:00.000Z",
    lastSyncAt: "2026-09-07T10:05:00.000Z",
    disabledAt: null,
    disabledReason: null,
  };

  it("non ha nessun campo che possa contenere il refresh token", () => {
    const parsed = googleAccountSchema.parse(full);
    expect(parsed).not.toHaveProperty("refreshToken");
    expect(parsed).not.toHaveProperty("refreshTokenEncrypted");
    expect(Object.keys(parsed).join(" ")).not.toMatch(/token|secret/i);
  });

  it("i campi accessori hanno un default: una risposta senza di essi resta parsabile", () => {
    const parsed = googleAccountSchema.parse({
      id: full.id,
      email: full.email,
      workspaceId: full.workspaceId,
      proposalsEnabled: false,
      connectedAt: full.connectedAt,
    });
    expect(parsed.workspaceName).toBe("");
    expect(parsed.scopes).toEqual([]);
    expect(parsed.lastSyncAt).toBeNull();
    expect(parsed.disabledAt).toBeNull();
    expect(parsed.disabledReason).toBeNull();
  });

  it("accetta un `disabledReason` sconosciuto senza far fallire il parse", () => {
    const parsed = googleAccountSchema.parse({ ...full, disabledReason: "motivo_futuro" });
    expect(parsed.disabledReason).toBe("motivo_futuro");
  });
});

describe("googleCallbackOutcomes", () => {
  it("contiene l'esito buono e i tre rifiuti che il callback sa distinguere", () => {
    expect(googleCallbackOutcomes).toEqual([
      "ok",
      "domain_mismatch",
      "no_refresh_token",
      "insufficient_scope",
      "error",
    ]);
  });
});

describe("emailRouteSchema", () => {
  it("accetta i quattro criteri e rifiuta gli altri", () => {
    for (const kind of ["sender_domain", "sender_address", "gmail_label", "keyword"] as const) {
      expect(emailRouteSchema.parse({ kind, value: "x" }).kind).toBe(kind);
    }
    expect(emailRouteSchema.safeParse({ kind: "subject", value: "x" }).success).toBe(false);
  });

  it("toglie gli spazi ai bordi del valore", () => {
    expect(emailRouteSchema.parse({ kind: "keyword", value: "  portale  " }).value).toBe("portale");
  });

  it("rifiuta un valore vuoto o fatto di soli spazi", () => {
    expect(emailRouteSchema.safeParse({ kind: "keyword", value: "" }).success).toBe(false);
    expect(emailRouteSchema.safeParse({ kind: "keyword", value: "   " }).success).toBe(false);
  });

  it("rifiuta un valore piu lungo del cap", () => {
    expect(emailRouteSchema.safeParse({ kind: "keyword", value: "x".repeat(201) }).success).toBe(
      false,
    );
  });

  it("NON normalizza il valore in minuscolo: quello lo fa il server con la stessa funzione del match", () => {
    expect(emailRouteSchema.parse({ kind: "sender_domain", value: "Acme.COM" }).value).toBe(
      "Acme.COM",
    );
  });
});

describe("emailRoutesPutSchema", () => {
  it("accetta un insieme vuoto: e come si cancellano tutte le regole", () => {
    expect(emailRoutesPutSchema.parse({ routes: [] }).routes).toEqual([]);
  });

  it("rifiuta piu di 200 regole", () => {
    const routes = Array.from({ length: 201 }, (_, i) => ({
      kind: "keyword" as const,
      value: `k${i}`,
    }));
    expect(emailRoutesPutSchema.safeParse({ routes }).success).toBe(false);
  });
});

describe("emailRoutesSchema / emailLabelsSchema", () => {
  it("una risposta senza il campo resta parsabile (default)", () => {
    expect(emailRoutesSchema.parse({}).routes).toEqual([]);
    expect(emailLabelsSchema.parse({}).labels).toEqual([]);
  });

  it("fa round-trip col corpo del PUT", () => {
    const body = { routes: [{ kind: "gmail_label" as const, value: "clienti" }] };
    expect(emailRoutesSchema.parse(emailRoutesPutSchema.parse(body))).toEqual(body);
  });
});
