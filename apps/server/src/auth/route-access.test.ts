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
  /** `config.credentialDoor`, se dichiarato. */
  credentialDoor?: true;
  /** `config.partialReauth`, se dichiarato (area 9, F3). */
  partialReauth?: true;
  /** `config.archived`, se dichiarato (area 9, F6). */
  archived?: "read" | "write";
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
      credentialDoor: route.config?.credentialDoor ?? prev?.credentialDoor,
      partialReauth: route.config?.partialReauth ?? prev?.partialReauth,
      archived: route.config?.archived ?? prev?.archived,
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

describe("porte che danno una sessione o un token", () => {
  /**
   * Ogni porta da cui si entra con le credenziali e si esce con una sessione
   * o un token passa dal secondo fattore (`docs/invariants/second-factor.md`).
   * La porta si DICHIARA (`config.credentialDoor`) e l'elenco è chiuso: una
   * porta nuova compare nel diff di questo test, e la review la vede.
   */
  it("le porte sono ESATTAMENTE queste", async () => {
    const doors = (await registeredRoutes()).filter((r) => r.credentialDoor).map((r) => r.key);
    expect(doors.sort()).toEqual([
      "POST /api/auth/desktop-exchange",
      "POST /api/auth/login",
      "POST /api/auth/mobile-login",
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
      "DELETE /api/ai-providers/:id",
      "DELETE /api/git-accounts/:id",
      "DELETE /api/me/security/passkeys/:id",
      "DELETE /api/projects/:projectId",
      "DELETE /api/projects/:projectId/members/:userId",
      "DELETE /api/repositories/:id/env-files/:fileId",
      "DELETE /api/repositories/:id/env-files/:fileId/vars/:key",
      "DELETE /api/roles/:id",
      "DELETE /api/settings/google-workspaces/:id",
      "DELETE /api/settings/webhooks/:id",
      "DELETE /api/users/:id/git-identities/:email",
      "DELETE /api/users/:id/second-factor",
      "DELETE /api/users/:id/slack",
      "PATCH /api/roles/:id",
      "PATCH /api/users/:id/email",
      "PATCH /api/users/:id/instance-role",
      "PATCH /api/users/:id/role",
      "POST /api/ai-providers",
      "POST /api/auth/desktop-handoff",
      "POST /api/auth/invites",
      "POST /api/auth/me/password",
      // Area 9, F1: il cambio della propria email di login.
      "POST /api/git-accounts",
      "POST /api/me/email-change",
      "POST /api/me/mail/proposals/:id/confirm-with-members",
      "POST /api/me/security/backup-codes",
      "POST /api/me/security/passkeys",
      "POST /api/me/security/passkeys/options",
      "POST /api/me/security/totp/setup (setup_allowed)",
      "POST /api/me/security/totp/setup/confirm (setup_allowed)",
      "POST /api/pats",
      // Area 8, «L'API per i siti»: il segreto d'identità del widget è una credenziale.
      "POST /api/plugins",
      "POST /api/plugins/:id/update",
      "POST /api/projects/:projectId/ingestion-key",
      "POST /api/projects/:projectId/widgets/:widgetId/identity-secret",
      "POST /api/repositories/:id/env-files/:fileId/import",
      "POST /api/repositories/:slug/webhook-secret",
      "POST /api/roles",
      "POST /api/roles/:id/duplicate",
      // Area 9, F1: disattivare e riattivare una persona.
      "POST /api/settings/google-workspaces",
      "POST /api/settings/webhooks",
      "POST /api/settings/webhooks/:id/secret",
      "POST /api/users/:id/deactivate",
      "POST /api/users/:id/git-identities",
      "POST /api/users/:id/password-reset",
      "POST /api/users/:id/reactivate",
      "POST /api/vault/activate",
      "POST /api/vault/keys",
      "POST /api/vault/keys/:id/seals",
      "POST /api/vault/recovery-key",
      "POST /api/vault/recovery/challenge",
      "POST /api/vault/recovery/confirm/:personKeyId",
      "POST /api/vault/recovery/pending",
      "PUT /api/projects/:projectId/members/:userId",
      "PUT /api/repositories/:id/env-files/:fileId/vars/:key",
      "PUT /api/users/:id/bitbucket",
      "PUT /api/users/:id/slack",
    ]);
  });

  /**
   * Area 9, F3 (D-5): le rotte che chiedono la riconferma solo per una PARTE
   * del corpo (un segreto nuovo), verificata dall'handler con `requireReauth`.
   */
  it("le rotte con riconferma PARZIALE sono ESATTAMENTE queste", async () => {
    const partial = (await registeredRoutes()).filter((r) => r.partialReauth).map((r) => r.key);
    expect(partial.sort()).toEqual([
      "DELETE /api/projects/:projectId/environments/:environmentId",
      "PATCH /api/ai-providers/:id",
      "PATCH /api/git-accounts/:id",
      "PATCH /api/settings/google-workspaces/:id",
      "PATCH /api/settings/webhooks/:id",
      "PUT /api/settings/instance",
      "PUT /api/settings/notifications",
    ]);
  });

  /**
   * Area 9, F6 (D-8): un progetto archiviato è come uno che non c'è, TRANNE
   * per queste rotte, che lo leggono (o lo riaprono, lo eliminano) di
   * proposito. Un'aggiunta qui è una scelta: va nel design.
   */
  it("le rotte che passano su un progetto ARCHIVIATO sono ESATTAMENTE queste, e solo di progetto", async () => {
    const routes = (await registeredRoutes()).filter((r) => r.archived);
    expect(routes.filter((r) => r.kind !== "project").map((r) => r.key)).toEqual([]);
    expect(routes.map((r) => `${r.key} ${r.archived}`).sort()).toEqual([
      "DELETE /api/projects/:projectId write",
      "GET /api/projects/:projectId/archived-view read",
      "GET /api/projects/:projectId/deletion-preview read",
      "POST /api/projects/:projectId/archive write",
      "POST /api/projects/:projectId/reopen write",
    ]);
  });
});
