import { ApiError } from "@stubwise/api-client";
import type { InviteLookup, RegisterResult } from "../../auth/register";
import type { ResetLinkStatus, ResetPasswordResult } from "../../auth/resetPassword";
import type { FirstAdminResult } from "../../auth/setup";
import { appClient, session } from "./client";

// Le pagine d'ingresso della web «app» (area 9, F1, R5; D-15 = b, E-4 = a)
// sulle rotte del server, con le firme del prototipo:
// - il reset della password (`/api/auth/password-reset/:token`): il server
//   risponde 410 per ogni link non usabile (usato, scaduto, inesistente),
//   e diventa «spent», una frase sola;
// - il primo avvio (`/api/auth/setup`): email e password, poi il nome con
//   il nome nel corpo (review F1, C1: mai un `PATCH /api/auth/me` col cookie
//   che il browser ha già, che rinominerebbe chi è dentro).
// - l'invito (`GET /api/auth/invites/:token`, decisione del maintainer): i
//   dettagli solo se valido; il server non distingue un invito usato o
//   revocato da uno sbagliato (è cancellato). La registrazione manda token e
//   password (l'email è quella dell'invito) e il nome nel corpo.

/** Le rotte (sul client vero). */
export interface EntryApi {
  resetLink(token: string): Promise<{ email: string; expiresAt: string }>;
  resetPassword(token: string, password: string): Promise<void>;
  /** Chi era dentro prima del reset (una sessione di questa app). */
  signedInBefore(): boolean;
  /** Se la sessione di questa app regge ancora (il reset chiude quelle della persona). */
  stillSignedIn(): Promise<boolean>;
  /**
   * Il nome va nel CORPO (review F1, C1): un `PATCH /api/auth/me` dopo
   * userebbe il cookie che il browser ha già, e rinominerebbe chi è dentro.
   */
  setup(email: string, password: string, displayName: string): Promise<{ user: { id: string } }>;
  /** La lettura pubblica dell'invito (`GET /api/auth/invites/:token`). */
  invite(token: string): Promise<{ status: string } & Partial<ServerInvite>>;
  register(token: string, password: string, displayName: string): Promise<{ user: { id: string } }>;
}

type ServerInvite = {
  email: string;
  invitedByName: string;
  projects: { code: string; name: string; roleName: string }[];
  instanceRoleName: string | null;
  expiresAt: string;
};

const gone = (error: unknown) => error instanceof ApiError && error.status === 410;
const badInput = (error: unknown) => error instanceof ApiError && error.status === 400;

export function createRealEntry(api: EntryApi) {
  return {
    async getResetLink(token: string): Promise<{ status: ResetLinkStatus }> {
      try {
        await api.resetLink(token);
        return { status: "valid" };
      } catch (error) {
        if (gone(error) || (error instanceof ApiError && error.status === 404)) {
          return { status: "spent" };
        }
        throw error;
      }
    },

    async resetPassword(token: string, input: { password: string }): Promise<ResetPasswordResult> {
      const wasIn = api.signedInBefore();
      try {
        await api.resetPassword(token, input.password);
      } catch (error) {
        if (gone(error)) return { ok: false, error: "spent" };
        if (badInput(error)) return { ok: false, error: "invalid_input", reason: "password" };
        throw error;
      }
      // Il reset chiude ogni sessione della persona: se era quella di questa app, si esce.
      const signedOutHere = wasIn && !(await api.stillSignedIn());
      return { ok: true, signedOutHere };
    },

    async getInvite(token: string): Promise<InviteLookup> {
      const r = await api.invite(token);
      if (r.status === "expired") return { status: "expired" };
      if (r.status !== "valid" || !r.email) return { status: "invalid" };
      return {
        status: "valid",
        email: r.email,
        invitedByName: r.invitedByName ?? "",
        // Il server dà il codice: è anche l'id che la pagina usa per le righe.
        projects: (r.projects ?? []).map((p) => ({ projectId: p.code, ...p })),
        instanceRoleName: r.instanceRoleName ?? null,
        expiresAt: r.expiresAt ?? "",
      };
    },

    async register(
      token: string,
      input: { name: string; password: string },
    ): Promise<RegisterResult> {
      if (!input.name.trim()) return { ok: false, error: "invalid_input", reason: "name" };
      let id: string;
      try {
        id = (await api.register(token, input.password, input.name.trim())).user.id;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : null;
        if (code === "invite_expired") return { ok: false, error: "expired" };
        if (gone(error)) return { ok: false, error: "invalid" };
        if (code === "email_already_exists") {
          return { ok: false, error: "invalid_input", reason: "email_taken" };
        }
        if (badInput(error)) return { ok: false, error: "invalid_input", reason: "password" };
        throw error;
      }
      // Si entra col login che segue (`useRegister`), con la persona nuova.
      return { ok: true, personId: id };
    },

    async createFirstAdmin(input: {
      name: string;
      email: string;
      password: string;
    }): Promise<FirstAdminResult> {
      if (!input.name.trim()) return { ok: false, error: "invalid_input", reason: "name" };
      let id: string;
      try {
        id = (await api.setup(input.email.trim(), input.password, input.name.trim())).user.id;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403)
          return { ok: false, error: "not_empty" };
        if (badInput(error)) return { ok: false, error: "invalid_input", reason: "password" };
        throw error;
      }
      return { ok: true, personId: id };
    },
  };
}

const AUTH = "/api/auth";

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: EntryApi = {
  resetLink: (token) =>
    appClient().request("GET", `${AUTH}/password-reset/${encodeURIComponent(token)}`) as Promise<{
      email: string;
      expiresAt: string;
    }>,
  resetPassword: async (token, password) => {
    await appClient().request("POST", `${AUTH}/password-reset/${encodeURIComponent(token)}`, {
      password,
    });
  },
  signedInBefore: () => session.personId !== null,
  stillSignedIn: () =>
    appClient()
      .auth.me()
      .then(() => true)
      .catch(() => false),
  setup: (email, password, displayName) =>
    appClient().request("POST", `${AUTH}/setup`, { email, password, displayName }) as Promise<{
      user: { id: string };
    }>,
  invite: (token) =>
    appClient().request("GET", `${AUTH}/invites/${encodeURIComponent(token)}`) as Promise<
      { status: string } & Partial<ServerInvite>
    >,
  register: (token, password, displayName) =>
    appClient().request("POST", `${AUTH}/register`, { token, password, displayName }) as Promise<{
      user: { id: string };
    }>,
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveEntryApiForTest = liveApi;

export const liveEntry = createRealEntry(liveApi);
