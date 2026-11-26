import { AsyncLocalStorage } from "node:async_hooks";
import { VIA_CLIENT_SETTING, type Db, type ViaClient } from "@stubwise/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionUser } from "../auth/session.js";

/**
 * D4 della parità MCP (design `docs/plans/2026-11-26-mcp-parita-design.md`,
 * «Decisioni»): ciò che una persona fa DA Claude Code porta «via Claude Code»
 * accanto a lei, nella storia del ticket e nel registro delle modifiche.
 * L'autore resta la persona.
 *
 * Com'è fatto, come il «via Claude» dell'app (0131):
 * - l'MCP manda `x-stubwise-client: claude-code` su ogni richiesta;
 * - l'header vale SOLO con un PAT `manual` (quello che si crea per Claude
 *   Code). Con un cookie, col PAT del desktop o del mobile non conta. Chi lo
 *   falsifica si dà da solo un'etichetta sulle sue azioni, nient'altro;
 * - la richiesta lo tiene in un `AsyncLocalStorage`, aperto in `onRequest`
 *   e riempito dall'hook dell'accesso dopo l'autenticazione;
 * - ogni transazione di `app.db` dentro quella richiesta comincia con
 *   `set_config('stubwise.via_client', 'claude_code', true)`, e le colonne
 *   `via_client` (commenti, storia del ticket, richieste di decisione,
 *   registro) la prendono di DEFAULT;
 * - `recordChange` la scrive anche esplicitamente, così vale pure quando
 *   il registro si scrive fuori da una transazione.
 *
 * Limite noto: una scrittura su quelle tabelle fatta FUORI da una
 * transazione, e non dal registro, non porta il segno. Oggi non ce ne
 * sono: i loro inserimenti passano tutti da un `tx`.
 */
export const VIA_CLIENT_HEADER = "x-stubwise-client";
const CLAUDE_CODE = "claude-code";

interface ViaClientStore {
  via: ViaClient | null;
}

const storage = new AsyncLocalStorage<ViaClientStore>();

/** Il segno della richiesta in corso, se c'è. */
export function currentViaClient(): ViaClient | null {
  return storage.getStore()?.via ?? null;
}

/** Da dove arriva la richiesta: `claude_code` solo per un PAT `manual` con l'header dell'MCP. */
export function viaClientOf(user: Pick<SessionUser, "patId" | "patKind">, headers: FastifyRequest["headers"]): ViaClient | null {
  if (user.patId === undefined || user.patKind !== "manual") return null;
  const header = headers[VIA_CLIENT_HEADER];
  return (Array.isArray(header) ? header[0] : header) === CLAUDE_CODE ? "claude_code" : null;
}

/** Dopo l'autenticazione (`accessPreHandler`): segna la richiesta. */
export function markViaClient(user: Pick<SessionUser, "patId" | "patKind">, headers: FastifyRequest["headers"]): void {
  const store = storage.getStore();
  if (store) store.via = viaClientOf(user, headers);
}

/**
 * Apre lo store di ogni richiesta, come `@fastify/request-context`: `run`
 * dentro `onRequest`, col resto del ciclo della richiesta nella sua callback.
 */
export function registerViaClientStore(app: FastifyInstance): void {
  app.addHook("onRequest", (_request, _reply, done) => {
    storage.run({ via: null }, done);
  });
}

/**
 * `db` con le transazioni che, dentro una richiesta segnata, cominciano
 * impostando `stubwise.via_client` (locale alla transazione: il pool non la
 * porta altrove). Il resto del client è quello di sempre.
 */
export function withViaClientTransactions(db: Db): Db {
  const transaction: Db["transaction"] = (fn, config) =>
    db.transaction(async (tx) => {
      const via = currentViaClient();
      if (via) await tx.execute(sql`select set_config(${VIA_CLIENT_SETTING}, ${via}, true)`);
      return fn(tx);
    }, config);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") return transaction;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
