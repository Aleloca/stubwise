import { ApiError } from "@stubwise/api-client";
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/browser";
import QRCode from "qrcode";
import { SECOND_FACTOR_MAX_FAILURES } from "../../auth/constants";
import type { TotpSetup } from "../../auth/reauth";
import type { ConfirmTotpResult } from "../../me/security";
import type { MeResult, MySecurity } from "../../me/types";
import { appClient } from "./client";

// Preferenze → Security nella build app (area 9, F1, R4b) sulle rotte del
// server (`/api/me/security/...`, `client.me.sessions`), con le firme del
// prototipo. Le passkey sul desktop non ci sono (vivono sul dominio
// dell'istanza, cioè nel browser: decisione del maintainer, 10 nov 2026):
// la lettura le dà vuote, e aggiungerne una resta del browser.

type ServerEvent = {
  id: string;
  kind: string;
  actorEmail: string | null;
  createdAt: string;
};

type ServerSecurity = {
  totp: { configured: boolean; confirmedAt: string | null };
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  backupCodesRemaining: number;
  events: ServerEvent[];
  attemptsLeft: number | null;
};

type ServerSession = {
  id: string;
  kind: string;
  userAgent: string | null;
  label: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
};

/** Le rotte (sul client vero: `client.request` su `/api/me/security`, `client.me`). */
export interface MeSecurityApi {
  security(): Promise<ServerSecurity>;
  sessions(): Promise<ServerSession[]>;
  endSession(id: string): Promise<void>;
  totpSetup(): Promise<{ secret: string; otpauthUrl: string }>;
  totpConfirm(code: string): Promise<{ backupCodes: string[] | null }>;
  backupCodes(): Promise<{ codes: string[] }>;
  renamePasskey(id: string, name: string): Promise<void>;
  removePasskey(id: string): Promise<void>;
  /** Le opzioni WebAuthn per registrare una passkey (`POST …/passkeys/options`, con la riconferma). */
  passkeyOptions(): Promise<unknown>;
  /** La cerimonia del browser (`startRegistration` di `@simplewebauthn/browser`). */
  createCredential(options: unknown): Promise<unknown>;
  registerPasskey(name: string, response: unknown): Promise<{ id: string }>;
}

/** Quanti codici fa ogni giro (`POST /api/me/security/backup-codes`). */
const BACKUP_CODES_TOTAL = 10;

/** I tipi del registro del server, nei tipi (e quindi nelle frasi) del prototipo. */
const EVENT_KINDS: Record<string, string> = {
  login: "signed_in",
  enrolled: "second_factor_enabled",
  totp_reconfigured: "authenticator_changed",
  passkey_added: "passkey_added",
  passkey_removed: "passkey_removed",
  backup_codes_regenerated: "backup_codes_regenerated",
  backup_code_used: "backup_code_used",
  locked: "second_factor_locked",
  second_factor_reset: "second_factor_reset",
  password_reset_link: "password_reset_link_created",
  deactivated: "deactivated",
  reactivated: "reactivated",
  email_changed: "email_changed",
  vault_key_created: "vault_key_created",
  vault_recovery_used: "vault_recovery_used",
  vault_activated: "vault_activated",
  vault_seal_replaced: "vault_seal_replaced",
  vault_recovery_key_rotated: "vault_recovery_key_rotated",
  reauth_desktop: "reauth_desktop",
};

/** Un tipo del server come tipo del prototipo; uno ignoto (un server più nuovo) è `other`. */
export const eventKindOf = (kind: string): string => EVENT_KINDS[kind] ?? "other";

/** Il dispositivo in parole da uno user agent: «Chrome on Windows». */
function deviceOf(userAgent: string | null): string {
  if (!userAgent) return "";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : null;
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Mac OS X|Macintosh/.test(userAgent)
        ? "macOS"
        : /Android/.test(userAgent)
          ? "Android"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? userAgent.slice(0, 60);
}

const codeOf = (error: unknown): string | null =>
  error instanceof ApiError ? (error.code ?? null) : null;

/** I rifiuti comuni nelle parole del prototipo, oppure si rilancia. */
function refusalOf(error: unknown): Extract<MeResult, { ok: false }> {
  const code = codeOf(error);
  if (code === "reauth_required") return { ok: false, error: "reauth_required" };
  if (error instanceof ApiError && error.status === 404) return { ok: false, error: "not_found" };
  if (error instanceof ApiError && error.status === 403) return { ok: false, error: "forbidden" };
  throw error;
}

export function createRealMeSecurity(api: MeSecurityApi, where: { desktop: () => boolean }) {
  return {
    async getMySecurity(): Promise<MySecurity> {
      const [s, sessions] = await Promise.all([api.security(), api.sessions().catch(() => [])]);
      return {
        on: s.totp.configured,
        totp: s.totp.configured,
        totpSince: s.totp.confirmedAt,
        // Il TOTP è obbligatorio e non si spegne: una passkey si toglie sempre.
        passkeys: where.desktop()
          ? []
          : (s.passkeys ?? []).map((k) => ({
              id: k.id,
              name: k.name,
              addedAt: k.createdAt,
              lastUsedAt: k.lastUsedAt,
              removable: true,
            })),
        backupCodesLeft: s.backupCodesRemaining ?? 0,
        backupCodesTotal: BACKUP_CODES_TOTAL,
        sessions: [...sessions]
          .sort(
            (a, b) =>
              Number(b.current) - Number(a.current) ||
              (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
          )
          .map((x) => ({
            id: x.id,
            device: {
              kind: x.kind === "desktop" || x.kind === "mobile" ? x.kind : "browser",
              detail: x.label ?? deviceOf(x.userAgent),
            },
            createdAt: x.createdAt,
            lastUsedAt: x.lastSeenAt ?? x.createdAt,
            current: x.current,
          })),
        // Un campo assente (un server di prima, una risposta parziale) è vuoto.
        events: (s.events ?? []).map((e) => ({
          id: e.id,
          kind: eventKindOf(e.kind),
          at: e.createdAt,
          byId: null,
          // Chi ha agito quando non è l'interessato (un admin): il server ne dà l'email.
          byName: e.actorEmail,
        })),
      };
    },

    async endSession(id: string): Promise<MeResult> {
      try {
        await api.endSession(id);
        return { ok: true };
      } catch (error) {
        if (codeOf(error) === "current_session")
          return { ok: false, error: "invalid", reason: "current" };
        return refusalOf(error);
      }
    },

    async startTotpSetup(): Promise<MeResult<{ setup: TotpSetup }>> {
      try {
        const r = await api.totpSetup();
        const qrSvg = await QRCode.toString(r.otpauthUrl, { type: "svg", margin: 0 });
        return { ok: true, setup: { secret: r.secret, uri: r.otpauthUrl, qrSvg } };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async confirmTotp(code: string): Promise<ConfirmTotpResult> {
      try {
        const r = await api.totpConfirm(code);
        return { ok: true, backupCodes: r.backupCodes };
      } catch (error) {
        if (error instanceof ApiError && error.status === 423) {
          const body = error.details as { lockedUntil?: string } | undefined;
          return {
            ok: false,
            error: "locked",
            lockedUntil: body?.lockedUntil ?? new Date().toISOString(),
          };
        }
        if (codeOf(error) === "invalid_second_factor") {
          // I tentativi rimasti non sono nel 401: si rilegge lo stato. Un
          // server di prima non li manda, e la frase resta senza contatore.
          const left = await api
            .security()
            .then((s) => s.attemptsLeft)
            .catch(() => null);
          return {
            ok: false,
            error: "invalid_code",
            triesLeft: left ?? SECOND_FACTOR_MAX_FAILURES - 1,
          };
        }
        return refusalOf(error);
      }
    },

    async regenerateBackupCodes(): Promise<MeResult<{ codes: string[] }>> {
      try {
        const r = await api.backupCodes();
        return { ok: true, codes: r.codes };
      } catch (error) {
        return refusalOf(error);
      }
    },

    async renamePasskey(id: string, name: string): Promise<MeResult> {
      try {
        await api.renamePasskey(id, name.trim());
        return { ok: true };
      } catch (error) {
        if (error instanceof ApiError && error.status === 400)
          return { ok: false, error: "invalid", reason: "name" };
        return refusalOf(error);
      }
    },

    /**
     * Una passkey nuova, nel browser: le opzioni (il server chiede lì la
     * riconferma), la cerimonia del browser, la registrazione col nome. Sul
     * desktop non si può: la passkey è del dominio dell'istanza.
     */
    async addPasskey(name: string): Promise<MeResult<{ passkeyId: string }>> {
      if (where.desktop()) return { ok: false, error: "invalid", reason: "browser_only" };
      try {
        const options = await api.passkeyOptions();
        let response: unknown;
        try {
          response = await api.createCredential(options);
        } catch {
          // Annullata, scaduta, nessun autenticatore: il browser non dice di più.
          return { ok: false, error: "invalid", reason: "passkey_failed" };
        }
        const created = await api.registerPasskey(name.trim(), response);
        return { ok: true, passkeyId: created.id };
      } catch (error) {
        if (error instanceof ApiError && error.status === 400) {
          return { ok: false, error: "invalid", reason: "passkey_failed" };
        }
        return refusalOf(error);
      }
    },

    async removePasskey(id: string): Promise<MeResult> {
      try {
        await api.removePasskey(id);
        return { ok: true };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}

const SECURITY = "/api/me/security";

/** Sul client vero (il client si legge a ogni chiamata). */
const liveApi: MeSecurityApi = {
  security: () => appClient().request("GET", SECURITY) as Promise<ServerSecurity>,
  sessions: () => appClient().me.sessions() as Promise<ServerSession[]>,
  endSession: (id) => appClient().me.endSession(id),
  totpSetup: () =>
    appClient().request("POST", `${SECURITY}/totp/setup`) as Promise<{
      secret: string;
      otpauthUrl: string;
    }>,
  totpConfirm: (code) =>
    appClient().request("POST", `${SECURITY}/totp/setup/confirm`, { code }) as Promise<{
      backupCodes: string[] | null;
    }>,
  backupCodes: () =>
    appClient().request("POST", `${SECURITY}/backup-codes`) as Promise<{ codes: string[] }>,
  renamePasskey: async (id, name) => {
    await appClient().request("PATCH", `${SECURITY}/passkeys/${encodeURIComponent(id)}`, { name });
  },
  removePasskey: async (id) => {
    await appClient().request("DELETE", `${SECURITY}/passkeys/${encodeURIComponent(id)}`);
  },
  passkeyOptions: () => appClient().request("POST", `${SECURITY}/passkeys/options`),
  createCredential: (options) =>
    startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON }),
  registerPasskey: (name, response) =>
    appClient().request("POST", `${SECURITY}/passkeys`, { name, response }) as Promise<{
      id: string;
    }>,
};

/** SOLO TEST: le rotte vere, per controllarne i percorsi. */
export const liveMeSecurityApiForTest = liveApi;

// Letto a ogni chiamata: il ponte del desktop c'è o non c'è (nei test arriva dopo).
export const liveMeSecurity = createRealMeSecurity(liveApi, {
  desktop: () => typeof window !== "undefined" && !!window.stubwise?.api,
});
