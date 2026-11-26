import { ApiError } from "@stubwise/api-client";
import type { MyProfile, ProfileInput } from "../../me/account";
import { avatarRefusal } from "../../me/accountRules";
import type { MailRefusal, PendingEmail } from "../../me/emailChange";
import type { MeResult } from "../../me/types";
import { appClient } from "./client";
import { authedDataUrl } from "./transport";

// Preferenze → Account nella build app (area 9, F1, R4a) sulle rotte del
// server (Task 7, 8 e 11 di 72), con le firme del prototipo:
// - il nome è il `displayName` di `PATCH /api/auth/me` (null = la parte
//   locale dell'email, come il server);
// - la foto va in `PUT /api/me/avatar` come byte grezzi; si legge da
//   `avatarUrl` con l'autenticazione (sul desktop il token non viaggia con un
//   `<img src>`), e torna come data URL;
// - il cambio d'email e la pagina del link (`/api/me/email-change`,
//   `/api/auth/email-change/...`): la lettura del link non conferma;
// - la password (`POST /api/auth/me/password`, con la riconferma): il server non
//   dice quante sessioni ha chiuso, si contano prima.

interface SessionUserLike {
  id: string;
  email: string;
  displayName?: string | null;
  avatarUrl: string | null;
}

type EmailChangeStatus = {
  available: boolean;
  pending: { newEmail: string; expiresAt: string } | null;
};

/** Le rotte (sul client vero: `client.auth`, `client.me`). */
export interface MeAccountApi {
  /** `departments`: rimandi, lotto 5 (72), assenti da un server di prima. */
  me(): Promise<{ user: SessionUserLike; departments?: { id: string }[] }>;
  setDisplayName(name: string): Promise<void>;
  putAvatar(bytes: Uint8Array): Promise<void>;
  deleteAvatar(): Promise<void>;
  /** L'immagine di `avatarUrl`, letta con l'autenticazione, come data URL. */
  avatarDataUrl(url: string): Promise<string | null>;
  emailChange(): Promise<EmailChangeStatus>;
  startEmailChange(newEmail: string): Promise<EmailChangeStatus>;
  cancelEmailChange(): Promise<void>;
  emailChangeLink(
    token: string,
  ): Promise<{ status: "valid"; newEmail: string } | { status: "invalid" | string }>;
  confirmEmailChange(token: string): Promise<{ email: string }>;
  changePassword(current: string, next: string): Promise<void>;
  sessions(): Promise<{ current: boolean }[]>;
}

const codeOf = (error: unknown): string | null =>
  error instanceof ApiError ? (error.code ?? null) : null;

const invalid = (reason: string) => ({ ok: false, error: "invalid", reason }) as const;

/** Le iniziali come nel binario: le prime lettere delle prime due parole. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** I byte di un data URL (base64). */
function bytesOf(dataUrl: string): Uint8Array | null {
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=]*)$/.exec(dataUrl);
  if (!m) return null;
  const raw = atob(m[1]!);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pendingOf = (s: EmailChangeStatus): PendingEmail | null =>
  s.pending ? { email: s.pending.newEmail, expiresAt: s.pending.expiresAt } : null;

export function createRealMeAccount(api: MeAccountApi) {
  /**
   * Una foto dell'istanza (percorso relativo) si legge con l'autenticazione;
   * una fuori dall'istanza (Slack, review F1, M5) si usa così com'è: non
   * vuole il nostro token, e non deve riceverlo.
   */
  async function photoOf(url: string | null): Promise<string | null> {
    if (!url) return null;
    if (/^https?:\/\//i.test(url)) return url;
    return api.avatarDataUrl(url);
  }

  return {
    async getMyProfile(): Promise<MyProfile> {
      const [{ user, departments }, change] = await Promise.all([api.me(), api.emailChange()]);
      const name = user.displayName?.trim() || user.email.split("@")[0]!;
      return {
        name,
        initials: initialsOf(name),
        email: user.email,
        photo: await photoOf(user.avatarUrl),
        // Rimandi, lotto 5, voce 5 (72, c703b66eb): il primo reparto della
        // persona colora le iniziali; nessuno (o un server di prima), il neutro.
        departmentId: departments?.[0]?.id ?? null,
        pendingEmail: pendingOf(change),
        emailChangeAvailable: change.available,
      };
    },

    async updateProfile(input: ProfileInput): Promise<MeResult> {
      try {
        if (input.name !== undefined) {
          if (!input.name.trim()) return invalid("name");
          await api.setDisplayName(input.name.trim());
        }
        if (input.avatar === null) await api.deleteAvatar();
        else if (input.avatar !== undefined) {
          // Review F1, M5: tipo (dai primi byte) e 512 KB PRIMA di mandarla,
          // con le parole del prototipo; il 415/413 del server resta la rete.
          const refusal = avatarRefusal(input.avatar);
          if (refusal) return invalid(refusal);
          const bytes = bytesOf(input.avatar);
          if (!bytes) return invalid("avatar_type");
          await api.putAvatar(bytes);
        }
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 415) return invalid("avatar_type");
        if (error instanceof ApiError && error.status === 413) return invalid("avatar_size");
        if (error instanceof ApiError && error.status === 400) return invalid("name");
        throw error;
      }
    },

    async requestEmailChange(
      newEmail: string,
    ): Promise<MeResult<{ pending: PendingEmail }> | MailRefusal> {
      try {
        const s = await api.startEmailChange(newEmail.trim());
        return { ok: true, pending: pendingOf(s)! };
      } catch (error) {
        const code = codeOf(error);
        if (code === "reauth_required") return { ok: false, error: "reauth_required" };
        if (code === "email_taken") return invalid("email_taken");
        if (code === "email_transport_unavailable" || code === "email_send_failed")
          return { ok: false, error: code };
        if (error instanceof ApiError && error.status === 400) return invalid("email");
        throw error;
      }
    },

    async cancelEmailChange(): Promise<MeResult> {
      await api.cancelEmailChange();
      return { ok: true };
    },

    async getEmailChangeLink(
      token: string,
    ): Promise<{ status: "valid"; email: string } | { status: "invalid" }> {
      const r = await api.emailChangeLink(token);
      return r.status === "valid" && "newEmail" in r
        ? { status: "valid", email: r.newEmail }
        : { status: "invalid" };
    },

    async confirmEmailChange(token: string): Promise<MeResult<{ email: string }>> {
      try {
        const { email } = await api.confirmEmailChange(token);
        return { ok: true, email };
      } catch (error) {
        const code = codeOf(error);
        if (code === "email_taken") return invalid("email_taken");
        if (code === "invalid_token") return invalid("link");
        throw error;
      }
    },

    async changePassword(input: {
      current: string;
      next: string;
    }): Promise<MeResult<{ signedOut: number }>> {
      // Le altre sessioni (browser, desktop, mobile) prima del cambio: dopo
      // il server le ha chiuse, e non lo dice.
      const others = (await api.sessions().catch(() => [])).filter((s) => !s.current).length;
      try {
        await api.changePassword(input.current, input.next);
        return { ok: true, signedOut: others };
      } catch (error) {
        const code = codeOf(error);
        if (code === "reauth_required") return { ok: false, error: "reauth_required" };
        if (code === "invalid_current_password") return invalid("wrong_password");
        if (error instanceof ApiError && error.status === 400) return invalid("too_short");
        throw error;
      }
    },
  };
}

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: MeAccountApi = {
  me: () => appClient().auth.me(),
  setDisplayName: async (name) => {
    await appClient().request("PATCH", "/api/auth/me", { displayName: name });
  },
  putAvatar: (bytes) => appClient().me.putAvatar(bytes),
  deleteAvatar: () => appClient().me.deleteAvatar(),
  avatarDataUrl: (url) => authedDataUrl(url),
  emailChange: () => appClient().me.emailChange(),
  startEmailChange: (email) => appClient().me.startEmailChange(email),
  cancelEmailChange: () => appClient().me.cancelEmailChange(),
  emailChangeLink: (token) => appClient().auth.emailChangeLink(token),
  confirmEmailChange: (token) => appClient().auth.confirmEmailChange(token),
  changePassword: async (current, next) => {
    await appClient().request("POST", "/api/auth/me/password", {
      currentPassword: current,
      newPassword: next,
    });
  },
  sessions: () => appClient().me.sessions(),
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveMeAccountApiForTest = liveApi;

export const liveMeAccount = createRealMeAccount(liveApi);
