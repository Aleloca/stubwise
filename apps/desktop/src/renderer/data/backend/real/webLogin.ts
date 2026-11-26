import { startAuthentication } from "@simplewebauthn/browser";
import { ApiError } from "@stubwise/api-client";
import {
  enrollConfirmResponseSchema,
  passkeyAuthenticationOptionsSchema,
  secondFactorStatusSchema,
  secondFactorVerifyResponseSchema,
  totpEnrollmentResponseSchema,
} from "@stubwise/shared";
import { appClient, session } from "./client";

// Il login a cookie del web (integrazione area 2, fetta 1): password, poi il
// secondo fattore — codice dell'app, codice di riserva o passkey (WebAuthn
// del browser, con @simplewebauthn/browser come il web vecchio) — o la
// configurazione obbligatoria dell'app per chi non ce l'ha. Sulle rotte cookie
// di oggi (`/api/auth/login`, `/api/auth/second-factor/*`): il server non
// cambia. Modulo a sé perché lo riusa la conferma del login del desktop
// dal browser (`/app/#/desktop-login`, Task 21).

/** Lo stadio della sessione parziale dopo la password. */
export type PartialStage = "second_factor" | "enrollment";

export type PasswordResult = { ok: true; stage: PartialStage } | { ok: false; error: "invalid_credentials" };

export type VerifyFailure =
  | { ok: false; error: "invalid_code" }
  | { ok: false; error: "locked"; lockedUntil: string }
  | { ok: false; error: "login_expired" }
  | { ok: false; error: "no_passkeys" };

export type VerifyResult = { ok: true; userId: string; backupCodesRemaining: number } | VerifyFailure;

/** Codici di riserva rimasti dopo l'ultimo ingresso col secondo fattore (per l'avviso «ne restano pochi»). */
export const lastLogin: { backupCodesRemaining: number | null } = { backupCodesRemaining: null };

export async function passwordLogin(email: string, password: string): Promise<PasswordResult> {
  try {
    const r = (await appClient().auth.login({ email, password })) as unknown as { stage?: PartialStage };
    session.partial = true;
    return { ok: true, stage: r.stage === "enrollment" ? "enrollment" : "second_factor" };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { ok: false, error: "invalid_credentials" };
    throw error;
  }
}

/** A che punto è il login a metà (`GET /second-factor`); `null` se non c'è più. */
export async function partialStatus(): Promise<{ stage: PartialStage; passkeys: boolean } | null> {
  try {
    const s = await appClient().request("GET", "/api/auth/second-factor", undefined, secondFactorStatusSchema);
    return { stage: s.stage === "enrollment" ? "enrollment" : "second_factor", passkeys: s.passkeys };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.partial = false;
      return null;
    }
    throw error;
  }
}

function failureOf(error: unknown): VerifyFailure {
  if (error instanceof ApiError) {
    if (error.status === 423) {
      const body = error.details as { lockedUntil?: string } | undefined;
      return { ok: false, error: "locked", lockedUntil: body?.lockedUntil ?? new Date().toISOString() };
    }
    if (error.code === "invalid_second_factor") return { ok: false, error: "invalid_code" };
    if (error.code === "no_passkeys") return { ok: false, error: "no_passkeys" };
    if (error.status === 401) {
      session.partial = false;
      return { ok: false, error: "login_expired" };
    }
  }
  throw error;
}

function entered(userId: string, backupCodesRemaining: number): VerifyResult {
  session.partial = false;
  session.personId = userId;
  lastLogin.backupCodesRemaining = backupCodesRemaining;
  return { ok: true, userId, backupCodesRemaining };
}

/** Un codice dell'app o di riserva (il server li distingue da sé). */
export async function verifyCode(code: string): Promise<VerifyResult> {
  try {
    const r = await appClient().request(
      "POST",
      "/api/auth/second-factor/verify",
      { code: code.trim() },
      secondFactorVerifyResponseSchema,
    );
    return entered(r.user.id, r.backupCodesRemaining);
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * La passkey: le opzioni dal server, la cerimonia del browser, la verifica.
 * Una cerimonia annullata o rifiutata dal browser non arriva al server: conta
 * come una passkey che non ha funzionato.
 */
export async function verifyPasskey(): Promise<VerifyResult> {
  let options: unknown;
  try {
    options = await appClient().request(
      "POST",
      "/api/auth/second-factor/passkey/options",
      undefined,
      passkeyAuthenticationOptionsSchema,
    );
  } catch (error) {
    return failureOf(error);
  }
  let response: unknown;
  try {
    response = await startAuthentication({
      optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
    });
  } catch {
    return { ok: false, error: "invalid_code" };
  }
  try {
    const r = await appClient().request(
      "POST",
      "/api/auth/second-factor/passkey/verify",
      { response },
      secondFactorVerifyResponseSchema,
    );
    return entered(r.user.id, r.backupCodesRemaining);
  } catch (error) {
    return failureOf(error);
  }
}

/** La configurazione obbligatoria: il segreto e l'URL `otpauth://` del QR. */
export async function startEnrollment(): Promise<{ secret: string; otpauthUrl: string }> {
  const r = await appClient().request(
    "POST",
    "/api/auth/second-factor/enroll",
    undefined,
    totpEnrollmentResponseSchema,
  );
  return { secret: r.secret, otpauthUrl: r.otpauthUrl };
}

/** Il primo codice dell'app appena configurata: dentro, coi codici di riserva (una volta). */
export async function confirmEnrollment(
  code: string,
): Promise<{ ok: true; userId: string; backupCodes: string[] } | { ok: false; error: "invalid_code" | "login_expired" }> {
  try {
    const r = await appClient().request(
      "POST",
      "/api/auth/second-factor/enroll/confirm",
      { code: code.trim() },
      enrollConfirmResponseSchema,
    );
    session.partial = false;
    session.personId = r.user.id;
    return { ok: true, userId: r.user.id, backupCodes: r.backupCodes };
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_second_factor")
      return { ok: false, error: "invalid_code" };
    if (error instanceof ApiError && error.status === 401) {
      session.partial = false;
      return { ok: false, error: "login_expired" };
    }
    throw error;
  }
}
