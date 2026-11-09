import { ApiError } from "@stubwise/api-client";
import type * as Fake from "../../api";
import { SECOND_FACTOR_MAX_FAILURES } from "../../auth/constants";
import type { Viewer } from "../../types";
import { appClient, session } from "./client";
import { NotIntegratedError, partialNamespace } from "./notIntegrated";
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

export const getSessionPerson: typeof Fake.getSessionPerson = async () => {
  try {
    const me = await appClient().auth.me();
    session.personId = me.user.id;
    session.partial = false;
    return me.user.id;
  } catch (error) {
    if (!isSignedOut(error)) throw error;
    session.personId = null;
    return null;
  }
};

/**
 * I permessi di chi è dentro, calcolati dal server per progetto
 * (`docs/invariants/permissions.md`: il client li legge, non li deduce). I
 * permessi di reparto arrivano con la fetta 3.
 */
export const getViewer: typeof Fake.getViewer = async () => {
  const me = await appClient().auth.me();
  return {
    personId: me.user.id,
    instancePermissions: me.instancePermissions,
    projectPermissions: me.projectPermissions,
    departmentPermissions: {},
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

export const auth: Auth = partialNamespace<Auth>("auth", {
  readEntry,
  logout,
  login,
  loginStage,
  loginSecondFactor,
  startLoginEnrollment,
  confirmLoginEnrollment,
});

type Me = typeof Fake.me;

/**
 * Solo ciò che il secondo passo del login legge (`useMySecondFactor`, dopo
 * l'ingresso con un codice di riserva): quanti codici restano. La sicurezza
 * dell'account (Preferenze) arriva con la sua area.
 */
const getMySecurity: Me["getMySecurity"] = async () =>
  ({
    on: true,
    passkeys: [],
    backupCodesLeft: web.lastLogin.backupCodesRemaining ?? 0,
  }) as unknown as Awaited<ReturnType<Me["getMySecurity"]>>;

export const me: Me = partialNamespace<Me>("me", { getMySecurity });
