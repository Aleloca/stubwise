/**
 * Rotte che non dichiarano ancora `config.access` e usano i loro preHandler
 * (`requireAuth`/`requireAdmin`, o nessuno se pubbliche): generato il 22 ott
 * 2026 dalle rotte registrate. L'elenco può solo SCENDERE — chi porta una rotta
 * sull'accesso dichiarato ne toglie la voce (`route-access.test.ts` lo
 * pretende). Ordinato, una voce `METHOD path` per riga.
 */
export const LEGACY_ROUTES: readonly string[] = [
  "GET /api/auth/password-reset/:token",
  "GET /api/auth/setup",
  "GET /api/me/google/callback",
  "GET /api/openapi.json",
  "GET /health",
  "GET /monitor/config",
  "GET /widget/:slug/config",
  "GET /widget/:slug/conversations/:conversationId/messages",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/mobile-login",
  "POST /api/auth/password-reset/:token",
  "POST /api/auth/register",
  "POST /api/auth/setup",
  "POST /api/inbound/:slug/ticket",
  "POST /api/slack/commands",
  "POST /api/slack/interactions",
  "POST /ingest/:slug",
  "POST /monitor/ingest",
  "POST /webhooks/git/:projectSlug",
  "POST /widget/:slug/conversations",
  "POST /widget/:slug/conversations/:conversationId/messages",
  "POST /widget/:slug/conversations/:conversationId/tickets",
];
