import { startAuthentication } from "@simplewebauthn/browser";
import { ApiError } from "@stubwise/api-client";
import { accountSecurityResponseSchema, passkeyAuthenticationOptionsSchema } from "@stubwise/shared";
import type * as Fake from "../../api";
import { SECOND_FACTOR_MAX_FAILURES } from "../../auth/constants";
import type { Viewer } from "../../types";
import { appClient, session } from "./client";
import { NotIntegratedError, partialNamespace } from "./notIntegrated";
import { forgetCommentTickets } from "./taskDetail";
import { forgetHomeCaches } from "./home";
import { forgetTaskCodes } from "./tasks";
import * as web from "./webLogin";

// La sessione della build app (integrazione area 2, fetta 1): chi è dentro e
// cosa può fare lo dice il server (`GET /api/auth/me`), mai il client. Sul
// web la sessione è il cookie; sul desktop il token che il processo main
// aggiunge a ogni richiesta (`api:request`).

/** Un 401 (fuori) o un 400 `no_instance` (desktop senza istanza): nessuno è dentro. */
function isSignedOut(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || (error.status === 400 && error.code === "no_instance"))
  );
}

/**
 * UNA lettura di `/api/auth/me` per chi è dentro e per i suoi permessi:
 * `getSessionPerson` la fa, `getViewer` usa la stessa risposta (o, se non c'è,
 * ne fa una). Una persona diversa da quella di prima svuota le cache del
 * client (codici delle task, ticket dei commenti).
 */
let lastMe: Promise<Awaited<ReturnType<ReturnType<typeof appClient>["auth"]["me"]>>> | null = null;

/** L'ultima persona vista dentro: anche dopo un 401 a metà, che azzera `session.personId`. */
let lastPerson: string | null = null;

export const getSessionPerson: typeof Fake.getSessionPerson = async () => {
  const before = lastPerson;
  lastMe = appClient().auth.me();
  try {
    const me = await lastMe;
    if (before !== null && before !== me.user.id) forgetClientCaches();
    lastPerson = me.user.id;
    session.personId = me.user.id;
    session.partial = false;
    return me.user.id;
  } catch (error) {
    lastMe = null;
    if (!isSignedOut(error)) throw error;
    if (before !== null) forgetClientCaches();
    lastPerson = null;
    session.personId = null;
    return null;
  }
};

function forgetClientCaches(): void {
  forgetTaskCodes();
  forgetCommentTickets();
  forgetHomeCaches();
}

/**
 * I permessi di chi è dentro, calcolati dal server per progetto
 * (`docs/invariants/permissions.md`: il client li legge, non li deduce), e
 * dalla fetta 3 quelli di reparto (`department.home.manage`).
 */
export const getViewer: typeof Fake.getViewer = async () => {
  // La lettura di `getSessionPerson` vale una volta sola (l'avvio): un viewer
  // riletto dopo un cambio di permessi chiede di nuovo `/api/auth/me`.
  const pending = lastMe;
  lastMe = null;
  const me = await (pending ?? appClient().auth.me());
  return {
    personId: me.user.id,
    instancePermissions: me.instancePermissions,
    projectPermissions: me.projectPermissions,
    departmentPermissions: me.departmentPermissions ?? {},
  } as Viewer;
};

type Auth = typeof Fake.auth;

const readEntry: Auth["readEntry"] = () => ({
  stage: session.personId !== null ? "in" : session.partial ? "second_factor" : "out",
  // Il primo avvio di un'istanza vuota si fa dal web: qui un'istanza c'è sempre.
  empty: false,
});

const logout: Auth["logout"] = async () => {
  try {
    if (window.stubwise?.session) await window.stubwise.session.logout();
    else await appClient().auth.logout();
  } finally {
    session.personId = null;
    session.partial = false;
  }
  return { ok: true };
};

/** Il login del desktop passa dal browser (Task 21): qui non c'è un modulo di password. */
function webOnly(fn: string): void {
  if (window.stubwise?.api) throw new NotIntegratedError(`auth.${fn} (desktop)`);
}

const login: Auth["login"] = async ({ email, password }) => {
  webOnly("login");
  const r = await web.passwordLogin(email, password);
  if (!r.ok) return r;
  return { ok: true, stage: "second_factor" };
};

const loginStage: Auth["loginStage"] = async () => {
  webOnly("loginStage");
  return (await web.partialStatus())?.stage ?? "second_factor";
};

const loginSecondFactor: Auth["loginSecondFactor"] = async (input) => {
  webOnly("loginSecondFactor");
  const r = input.method === "passkey" ? await web.verifyPasskey() : await web.verifyCode(input.code);
  if (r.ok) return { ok: true, stage: "in", personId: r.userId };
  if (r.error === "locked") return { ok: false, error: "locked", lockedUntil: r.lockedUntil };
  if (r.error === "login_expired") return { ok: false, error: "login_expired" };
  if (r.error === "no_passkeys") return { ok: false, error: "no_second_factor" };
  // Il server non dice quanti tentativi restano: la frase generica (`wrongCodeMessage`).
  return { ok: false, error: "invalid_code", triesLeft: SECOND_FACTOR_MAX_FAILURES - 1 };
};

const startLoginEnrollment: Auth["startLoginEnrollment"] = async () => {
  webOnly("startLoginEnrollment");
  return web.startEnrollment();
};

const confirmLoginEnrollment: Auth["confirmLoginEnrollment"] = async (code) => {
  webOnly("confirmLoginEnrollment");
  const r = await web.confirmEnrollment(code);
  return r.ok ? { ok: true, personId: r.userId, backupCodes: r.backupCodes } : r;
};

/**
 * La conferma del login del desktop (`/app/#/desktop-login`, Task 21): il
 * codice monouso legato al challenge PKCE del desktop. Si chiede SOLO dal
 * clic su «Allow». Il server vuole la riconferma (`config.reauth`): un
 * `reauth_required` torna nella forma che `useReauth()` riconosce, e il
 * dialogo «Confirm it's you» la fa ripartire.
 */
const desktopHandoff: Auth["desktopHandoff"] = async (input) => {
  try {
    const r = await appClient().auth.desktopHandoff(input);
    return { ok: true, code: r.code };
  } catch (error) {
    if (error instanceof ApiError && error.code === "reauth_required") return { ok: false, error: "reauth_required" };
    return { ok: false, error: "failed" };
  }
};

type ReauthInput = Parameters<Auth["reauthenticate"]>[0];
type ReauthResult = Awaited<ReturnType<Auth["reauthenticate"]>>;

/** Gli esiti delle rotte di riconferma nella forma del prototipo. */
function reauthFailure(error: unknown): ReauthResult {
  if (error instanceof ApiError) {
    if (error.status === 423) {
      const body = error.details as { lockedUntil?: string } | undefined;
      return { ok: false, error: "locked", lockedUntil: body?.lockedUntil ?? new Date().toISOString() };
    }
    if (error.code === "invalid_second_factor") {
      // Il server non dice quanti tentativi restano: la frase generica.
      return { ok: false, error: "invalid_code", triesLeft: SECOND_FACTOR_MAX_FAILURES - 1 };
    }
    if (error.code === "no_passkeys" || error.code === "second_factor_setup_required") {
      return { ok: false, error: "no_second_factor" };
    }
  }
  throw error;
}

/**
 * La riconferma («Confirm it's you») sulle rotte di oggi: un codice dell'app
 * o di riserva su `POST /api/me/security/reauth`, una passkey con le opzioni
 * del server e la cerimonia del browser. Una cerimonia annullata non arriva al
 * server: conta come un codice che non ha funzionato.
 */
const reauthenticate: Auth["reauthenticate"] = async (input: ReauthInput) => {
  const client = appClient();
  try {
    if (input.method !== "passkey") {
      await client.request("POST", "/api/me/security/reauth", { code: input.code.trim() });
      return { ok: true };
    }
    const options = await client.request(
      "POST",
      "/api/me/security/reauth/passkey/options",
      {},
      passkeyAuthenticationOptionsSchema,
    );
    let response: unknown;
    try {
      response = await startAuthentication({
        optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
    } catch {
      return { ok: false, error: "invalid_code", triesLeft: SECOND_FACTOR_MAX_FAILURES - 1 };
    }
    await client.request("POST", "/api/me/security/reauth/passkey/verify", { response });
    return { ok: true };
  } catch (error) {
    return reauthFailure(error);
  }
};

export const auth: Auth = partialNamespace<Auth>("auth", {
  readEntry,
  logout,
  login,
  loginStage,
  loginSecondFactor,
  startLoginEnrollment,
  confirmLoginEnrollment,
  desktopHandoff,
  reauthenticate,
});

type Me = typeof Fake.me;

/**
 * Solo ciò che leggono il secondo passo del login (quanti codici di riserva
 * restano) e il dialogo di riconferma (quali modi ha chi guarda: le passkey
 * contano), da `GET /api/me/security`. La sicurezza dell'account (Preferenze)
 * arriva con la sua area. Senza una sessione completa (il login a metà) si
 * ripiega sull'ultimo ingresso.
 */
const getMySecurity: Me["getMySecurity"] = async () => {
  try {
    const s = await appClient().request("GET", "/api/me/security", undefined, accountSecurityResponseSchema);
    return {
      on: s.totp.configured,
      passkeys: s.passkeys,
      backupCodesLeft: s.backupCodesRemaining,
    } as unknown as Awaited<ReturnType<Me["getMySecurity"]>>;
  } catch (error) {
    // Un login a metà (401) o una lettura che non riesce: l'ultimo ingresso.
    if (!(error instanceof ApiError)) throw error;
    return {
      on: true,
      passkeys: [],
      backupCodesLeft: web.lastLogin.backupCodesRemaining ?? 0,
    } as unknown as Awaited<ReturnType<Me["getMySecurity"]>>;
  }
};

export const me: Me = partialNamespace<Me>("me", { getMySecurity });
