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
//   `PATCH /api/auth/me` (la risposta apre già la sessione).
// - l'invito (`GET /api/auth/invites/:token`, decisione del maintainer): i
//   dettagli solo se valido; il server non distingue un invito usato o
//   revocato da uno sbagliato (è cancellato). La registrazione manda token e
//   password (l'email è quella dell'invito), poi il nome con `PATCH`.

/** Le rotte (sul client vero). */
export interface EntryApi {
  resetLink(token: string): Promise<{ email: string; expiresAt: string }>;
  resetPassword(token: string, password: string): Promise<void>;
  /** Chi era dentro prima del reset (una sessione di questa app). */
  signedInBefore(): boolean;
  /** Se la sessione di questa app regge ancora (il reset chiude quelle della persona). */
  stillSignedIn(): Promise<boolean>;
  setup(email: string, password: string): Promise<{ user: { id: string } }>;
  setDisplayName(name: string): Promise<void>;
  /** Si è dentro come questa persona (lo stato della sessione dell'app). */
  entered(personId: string): void;
  /** La lettura pubblica dell'invito (`GET /api/auth/invites/:token`). */
  invite(token: string): Promise<{ status: string } & Partial<ServerInvite>>;
  register(token: string, password: string): Promise<{ user: { id: string } }>;
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
        id = (await api.register(token, input.password)).user.id;
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
      api.entered(id);
      await api.setDisplayName(input.name.trim()).catch(() => undefined);
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
        id = (await api.setup(input.email.trim(), input.password)).user.id;
      } catch (error) {
        if (error instanceof ApiError && error.status === 403)
          return { ok: false, error: "not_empty" };
        if (badInput(error)) return { ok: false, error: "invalid_input", reason: "password" };
        throw error;
      }
      api.entered(id);
      await api.setDisplayName(input.name.trim()).catch(() => undefined);
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
  setup: (email, password) =>
    appClient().request("POST", `${AUTH}/setup`, { email, password }) as Promise<{
      user: { id: string };
    }>,
  setDisplayName: async (name) => {
    await appClient().request("PATCH", `${AUTH}/me`, { displayName: name });
  },
  invite: (token) =>
    appClient().request("GET", `${AUTH}/invites/${encodeURIComponent(token)}`) as Promise<
      { status: string } & Partial<ServerInvite>
    >,
  register: (token, password) =>
    appClient().request("POST", `${AUTH}/register`, { token, password }) as Promise<{
      user: { id: string };
    }>,
  entered: (personId) => {
    session.personId = personId;
    session.partial = false;
    session.empty = false;
  },
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveEntryApiForTest = liveApi;

export const liveEntry = createRealEntry(liveApi);
