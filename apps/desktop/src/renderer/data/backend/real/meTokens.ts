import { ApiError } from "@stubwise/api-client";
import { buildInstallCommand, claudeCodeTokenName } from "../../me/claudeCodeCommand";
import type { MeResult, TokenView } from "../../me/types";
import { appClient } from "./client";
import { instanceOrigin } from "./supportWidgets";

// Preferenze → Tokens e Claude Code nella build app (area 9, F1, R4c) sulle
// rotte del server (`/api/pats`), con le firme del prototipo. Creare chiede
// la riconferma (sul server `config.reauth`); il token esce UNA volta, nella
// risposta della creazione. Il comando di Claude Code è quello del web, con
// l'indirizzo vero dell'istanza.

type Pat = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
};

/** Le rotte (sul client vero: `client.request` su `/api/pats`, `client.pats.revoke`). */
export interface MeTokensApi {
  list(): Promise<Pat[]>;
  create(name: string, expiresAt: string | null): Promise<Pat & { token: string }>;
  revoke(id: string): Promise<void>;
  /** L'indirizzo dell'istanza per il comando. */
  origin(): Promise<string>;
  now(): string;
}

function refusalOf(error: unknown): Extract<MeResult, { ok: false }> {
  if (error instanceof ApiError && error.code === "reauth_required") {
    return { ok: false, error: "reauth_required" };
  }
  if (error instanceof ApiError && error.status === 400) {
    return { ok: false, error: "invalid", reason: "name" };
  }
  if (error instanceof ApiError && error.status === 404) return { ok: false, error: "not_found" };
  throw error;
}

export function createRealMeTokens(api: MeTokensApi) {
  const create = async (name: string, expiresAt: string | null) => {
    try {
      return { ok: true as const, pat: await api.create(name, expiresAt) };
    } catch (error) {
      return refusalOf(error);
    }
  };

  return {
    async listTokens(): Promise<TokenView[]> {
      const now = Date.parse(api.now());
      return (await api.list()).map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        expired: t.expiresAt !== null && Date.parse(t.expiresAt) <= now,
        lastUsedAt: t.lastUsedAt,
      }));
    },

    async createToken(input: {
      name: string;
      expiresAt: string | null;
    }): Promise<MeResult<{ tokenId: string; token: string }>> {
      const r = await create(input.name.trim(), input.expiresAt);
      return r.ok ? { ok: true, tokenId: r.pat.id, token: r.pat.token } : r;
    },

    async revokeToken(id: string): Promise<MeResult> {
      try {
        await api.revoke(id);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async createClaudeCodeCommand(): Promise<
      MeResult<{ command: string; tokenId: string; tokenName: string }>
    > {
      const tokenName = claudeCodeTokenName(api.now());
      const r = await create(tokenName, null);
      if (!r.ok) return r;
      const command = buildInstallCommand(await api.origin(), r.pat.token);
      return { ok: true, command, tokenId: r.pat.id, tokenName };
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: MeTokensApi = {
  list: () => appClient().request("GET", "/api/pats") as Promise<Pat[]>,
  create: (name, expiresAt) =>
    appClient().request("POST", "/api/pats", { name, expiresAt }) as Promise<
      Pat & { token: string }
    >,
  revoke: (id) => appClient().pats.revoke(id),
  origin: instanceOrigin,
  now: () => new Date().toISOString(),
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveMeTokensApiForTest = liveApi;

export const liveMeTokens = createRealMeTokens(liveApi);
