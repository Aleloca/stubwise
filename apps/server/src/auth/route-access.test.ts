import type { RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

/**
 * Ogni rotta dichiara il suo accesso in `config.access` (vedi `access.ts`),
 * anche quelle pubbliche (`{ kind: "public" }`): una rotta senza
 * dichiarazione fa fallire il test. Non esiste un elenco di eccezioni — la
 * transizione dai `preHandler` scritti a mano si è chiusa il 22 ott 2026 —
 * e non va reintrodotto: una rotta pubblica con la sua autenticazione
 * (firma HMAC, chiave del server, token del widget) dichiara `public` e
 * tiene il suo controllo nel `preValidation` o nell'handler.
 */

interface CollectedRoute {
  key: string;
  hasAccess: boolean;
  /** `config.access.kind`, se dichiarato. */
  kind?: string;
  /** `config.reauth`, se dichiarato. */
  reauth?: true | "setup_allowed";
}

/**
 * `METHOD path`, una voce per metodo. Lo slash finale si toglie: con
 * `prefixTrailingSlash: "both"` una rotta "/" sotto un prefisso è registrata
 * due volte (con e senza slash), ma è la stessa rotta.
 */
function collect(route: RouteOptions, into: Map<string, CollectedRoute>): void {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  const url = route.url.length > 1 ? route.url.replace(/\/$/, "") : route.url;
  for (const method of methods) {
    // HEAD e OPTIONS non sono rotte nostre: Fastify aggiunge da sé un HEAD
    // per ogni GET, con la stessa config.
    if (method === "HEAD" || method === "OPTIONS") continue;
    const key = `${method} ${url}`;
    const access = route.config?.access;
    const hasAccess = access !== undefined;
    const prev = into.get(key);
    into.set(key, {
      key,
      hasAccess: (prev?.hasAccess ?? false) || hasAccess,
      kind: access?.kind ?? prev?.kind,
      reauth: route.config?.reauth ?? prev?.reauth,
    });
  }
}

async function registeredRoutes(): Promise<CollectedRoute[]> {
  const routes = new Map<string, CollectedRoute>();
  const app = buildApp({ onRoute: (route) => collect(route, routes) });
  await app.ready();
  await app.close();
  return [...routes.values()].sort((a, b) => a.key.localeCompare(b.key));
}

describe("ogni rotta dichiara config.access", () => {
  it("nessuna rotta senza config.access", async () => {
    const undeclared = (await registeredRoutes()).filter((r) => !r.hasAccess).map((r) => r.key);
    expect(undeclared).toEqual([]);
  });

  it("il registro vede davvero le rotte (non passa a vuoto)", async () => {
    const keys = (await registeredRoutes()).map((r) => r.key);
    expect(keys).toContain("GET /health");
    expect(keys).toContain("POST /webhooks/git/:projectSlug");
    expect(keys.length).toBeGreaterThan(100);
  });
});

describe("rotte della sessione parziale", () => {
  /**
   * Le rotte `second_factor` sono le SOLE che una sessione parziale (login a
   * metà, prima del secondo fattore) raggiunge: ogni altra risponde 401
   * `second_factor_required`. L'elenco è chiuso apposta, perché una rotta
   * dichiarata `second_factor` per sbaglio è un buco nel secondo fattore: chi
   * ne aggiunge una aggiorna questo elenco, e la review lo vede.
   */
  it("le rotte second_factor sono ESATTAMENTE queste", async () => {
    const secondFactorRoutes = (await registeredRoutes())
      .filter((r) => r.kind === "second_factor")
      .map((r) => r.key);
    expect(secondFactorRoutes.sort()).toEqual([
      "GET /api/auth/second-factor",
      "POST /api/auth/second-factor/enroll",
      "POST /api/auth/second-factor/enroll/confirm",
      "POST /api/auth/second-factor/passkey/options",
      "POST /api/auth/second-factor/passkey/verify",
      "POST /api/auth/second-factor/verify",
    ]);
  });
});

describe("rotte con riconferma recente", () => {
  /**
   * Le azioni sensibili chiedono un secondo fattore recente (`config.reauth`,
   * vedi `access.ts`): dichiarato, non ricordato. Come per `second_factor`,
   * l'elenco è chiuso: una rotta sensibile che se ne dimentica non compare
   * qui, e chi ne aggiunge una aggiorna l'elenco (in ordine).
   */
  it("le rotte con riconferma sono ESATTAMENTE queste", async () => {
    const reauthRoutes = (await registeredRoutes())
      .filter((r) => r.reauth !== undefined)
      .map((r) => (r.reauth === true ? r.key : `${r.key} (${r.reauth})`));
    expect(reauthRoutes.sort()).toEqual([
      "DELETE /api/me/security/passkeys/:id",
      "DELETE /api/projects/:projectId/members/:userId",
      "DELETE /api/roles/:id",
      "DELETE /api/users/:id/git-identities/:email",
      "DELETE /api/users/:id/second-factor",
      "DELETE /api/users/:id/slack",
      "PATCH /api/roles/:id",
      "PATCH /api/users/:id/instance-role",
      "PATCH /api/users/:id/role",
      "POST /api/auth/me/password",
      "POST /api/me/security/backup-codes",
      "POST /api/me/security/passkeys",
      "POST /api/me/security/passkeys/options",
      "POST /api/me/security/totp/setup (setup_allowed)",
      "POST /api/me/security/totp/setup/confirm (setup_allowed)",
      "POST /api/pats",
      "POST /api/roles",
      "POST /api/roles/:id/duplicate",
      "POST /api/users/:id/git-identities",
      "POST /api/users/:id/password-reset",
      "PUT /api/projects/:projectId/members/:userId",
      "PUT /api/users/:id/slack",
    ]);
  });
});
