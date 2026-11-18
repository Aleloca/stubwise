import { ApiError } from "@stubwise/api-client";
import { GOOGLE_OAUTH_CALLBACK_PATH } from "@stubwise/shared";
import type { GoogleAppView } from "../../instance/google";
import type { InstanceResult } from "../../instance/types";
import { appClient } from "./client";
import { instanceOrigin } from "./supportWidgets";

// Amministrazione → Google Workspace nella build app (area 9, F3) su
// `/api/settings/google-workspaces` (72). Il server decide la riconferma
// (crea, sostituisce il secret, elimina) e il 409 `workspace_in_use`.
//
// Differenze dichiarate (parità): il server non tiene le ultime 4 del client
// secret («••••»), e delle caselle collegate dà solo il numero
// (`accountCount`): il dialogo di un'app in uso le dice contate, senza nomi.
// L'indirizzo di ritorno OAuth è quello del server (`redirectUri`), non la
// costante del prototipo.

/* eslint-disable @typescript-eslint/no-explicit-any -- forme del server lette dai Reader */
type Any = any;

/** Le rotte (sul client vero: `client.googleApps`), più l'origine dell'istanza. */
export interface GoogleAppsApi {
  list(): Promise<Any[]>;
  create(input: {
    name: string;
    domains: string[];
    clientId: string;
    clientSecret: string;
  }): Promise<Any>;
  update(
    id: string,
    patch: { name?: string; domains?: string[]; clientId?: string; clientSecret?: string },
  ): Promise<Any>;
  remove(id: string): Promise<void>;
  origin(): Promise<string>;
}

export function createRealGoogleApps(api: GoogleAppsApi) {
  /** I rifiuti; `in_use` col numero di caselle della riga (il server non dà i nomi). */
  function refusalOf(error: unknown, accounts = 0): Extract<InstanceResult, { ok: false }> {
    if (!(error instanceof ApiError)) throw error;
    const code = error.code ?? "";
    if (code === "reauth_required") return { ok: false, error: "reauth_required" };
    if (code === "workspace_in_use")
      return { ok: false, error: "in_use", usedBy: [], hiddenCount: accounts };
    if (error.status === 404) return { ok: false, error: "not_found" };
    if (error.status === 403) return { ok: false, error: "forbidden" };
    if (error.status === 409) return { ok: false, error: "conflict" };
    if (error.status === 400) {
      const field = /\b(domains|clientId|clientSecret|name)\b/.exec(error.message)?.[1] ?? "name";
      return { ok: false, error: "invalid", reason: field };
    }
    if (code) return { ok: false, error: "invalid", reason: code };
    throw error;
  }

  const viewOf = (w: Any): GoogleAppView => ({
    id: w.id,
    name: w.name,
    domains: [...(w.domains ?? [])],
    clientId: w.clientId,
    last4: "",
    createdAt: w.createdAt,
    mailboxCount: w.accountCount ?? 0,
    mailboxPeople: [],
    hiddenMailboxCount: w.accountCount ?? 0,
  });

  async function write(call: () => Promise<unknown>, accounts = 0): Promise<InstanceResult> {
    try {
      await call();
      return { ok: true };
    } catch (error) {
      return refusalOf(error, accounts);
    }
  }

  return {
    async listGoogleApps(): Promise<GoogleAppView[]> {
      return (await api.list()).map(viewOf);
    },

    /** L'indirizzo di ritorno OAuth da dare a Google: quello del server. */
    async getGoogleRedirectUri(): Promise<string> {
      const [first] = await api.list();
      return first?.redirectUri ?? `${await api.origin()}${GOOGLE_OAUTH_CALLBACK_PATH}`;
    },

    async createGoogleApp(input: {
      name: string;
      domains: string[];
      clientId: string;
      clientSecret: string;
    }): Promise<InstanceResult<{ appId: string }>> {
      try {
        const r = await api.create({
          name: input.name.trim(),
          domains: input.domains,
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret,
        });
        return { ok: true, appId: r.id as string };
      } catch (error) {
        return refusalOf(error);
      }
    },

    updateGoogleApp: (
      id: string,
      patch: { name?: string; domains?: string[]; clientId?: string },
    ) => write(() => api.update(id, patch)),

    replaceGoogleSecret: (id: string, secret: string) =>
      write(() => api.update(id, { clientSecret: secret })),

    async deleteGoogleApp(id: string): Promise<InstanceResult> {
      const accounts = (await api.list()).find((w) => w.id === id)?.accountCount ?? 0;
      return write(() => api.remove(id), accounts);
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: GoogleAppsApi = {
  list: () => appClient().googleApps.list() as Promise<Any[]>,
  create: (input) => appClient().googleApps.create(input as Any),
  update: (id, patch) => appClient().googleApps.update(id, patch as Any),
  remove: (id) => appClient().googleApps.remove(id),
  origin: instanceOrigin,
};

/** SOLO TEST: le rotte vere. */
export const liveGoogleAppsApiForTest = liveApi;

export const liveGoogleApps = createRealGoogleApps(liveApi);
