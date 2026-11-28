import { startAuthentication } from "@simplewebauthn/browser";
import { ApiError } from "@stubwise/api-client";
import { passkeyAuthenticationOptionsSchema } from "@stubwise/shared";
import type * as Fake from "../../api";
import { SECOND_FACTOR_MAX_FAILURES } from "../../auth/constants";
import type { Viewer } from "../../types";
import { forgetCalendarWrites } from "./calendarWrites";
import { forgetPeopleChatCaches } from "./chat";
import { resetChatStreams } from "./chatStream";
import { forgetChatCaches } from "./claudeChat";
import { forgetTrials } from "./claudeTrial";
import { forgetDocsCaches } from "./docs";
import { forgetProductClaude } from "./productClaude";
import { forgetProductDocs } from "./productDocs";
import { forgetProductLive } from "./productLive";
import { appClient, session } from "./client";
import { NotIntegratedError, partialNamespace } from "./notIntegrated";
import { forgetCommentTickets } from "./taskDetail";
import { forgetAutomationRefs } from "./automationsLive";
import { forgetRevealedAgentKeys } from "../../revealedAgentKey";
import { forgetRevealedAddresses } from "../../revealedAddress";
import { forgetStreams } from "./claudeStream";
import { forgetFilterCaches } from "./filters";
import { forgetHomeCaches } from "./home";
import { forgetTaskCodes } from "./tasks";
import * as web from "./webLogin";
import { liveMeAccount } from "./meAccount";
import { liveMeSecurity } from "./meSecurity";
import { liveMeTokens } from "./meTokens";
import { liveEntry } from "./entry";
import { liveMeMailboxes } from "./meMailboxes";

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

type AuthMe = Awaited<ReturnType<ReturnType<typeof appClient>["auth"]["me"]>>;

/** L'ultima risposta di `/api/auth/me` con cui `getViewer` ha calcolato chi guarda. */
let viewerMe: AuthMe | null = null;

/**
 * I permessi di chi guarda come li ha usati l'ultimo `getViewer`, senza una
 * seconda lettura di `/api/auth/me` (la cassaforte, lotto 10): `lastMe` vale
 * una volta sola, e non si tocca. Solo se il viewer non c'è ancora, una
 * lettura a parte.
 */
export function currentMe(): Promise<AuthMe> {
  return viewerMe ? Promise.resolve(viewerMe) : appClient().auth.me();
}

/** L'ultima persona vista dentro: anche dopo un 401 a metà, che azzera `session.personId`. */
let lastPerson: string | null = null;

export const getSessionPerson: typeof Fake.getSessionPerson = async () => {
  const before = lastPerson;
  lastMe = appClient().auth.me();
  try {
    const me = await lastMe;
    if (before !== null && before !== me.user.id) {
      viewerMe = null;
      forgetClientCaches();
    }
    lastPerson = me.user.id;
    session.personId = me.user.id;
    session.partial = false;
    return me.user.id;
  } catch (error) {
    lastMe = null;
    if (!isSignedOut(error)) throw error;
    viewerMe = null;
    if (before !== null) forgetClientCaches();
    lastPerson = null;
    session.personId = null;
    // Area 9, R5: fuori, nella web «app», un'istanza senza nessuno porta al
    // primo avvio. Sul desktop un'istanza scelta ha sempre qualcuno.
    session.empty = window.stubwise?.api
      ? false
      : await appClient()
          .auth.setupStatus()
          .then((s) => s.needed)
          .catch(() => false);
    return null;
  }
};

function forgetClientCaches(): void {
  // I Docs (area 5): spazi, pagine lette, resoconti del grafo, testi delle note.
  forgetDocsCaches();
  forgetTaskCodes();
  forgetCommentTickets();
  // Le Automations (area 7): codici e revisioni letti, e il segreto di un webhook appena visto.
  forgetAutomationRefs();
  forgetRevealedAddresses();
  // I Server (area 8, F4a): una chiave dell'agente appena creata e non ancora mostrata (I2).
  forgetRevealedAgentKeys();
  // Il Calendario (F4): etag visti e salvataggi in corso o non riusciti.
  forgetCalendarWrites();
  forgetHomeCaches();
  forgetFilterCaches();
  forgetStreams();
  forgetChatCaches();
  // Area 10, F2: le prove di Claude erano della persona di prima.
  forgetTrials();
  forgetPeopleChatCaches();
  resetChatStreams();
  // Area 11 (M3 della revisione di R11-1): `baseSeq`, codici e ultime pagine lette;
  // e gli stream dal vivo e i battiti della persona di prima (revisione di R11-4, 14).
  forgetProductDocs();
  forgetProductLive();
  forgetProductClaude();
}

/**
 * I permessi di chi è dentro, calcolati dal server per progetto
 * (`docs/invariants/permissions.md`: il client li legge, non li deduce), e
 * dalla fetta 3 quelli di reparto (`department.home.manage`).
 */
/**
 * I permessi d'istanza di chi è dentro, dal viewer già letto (nessuna lettura
 * in più di `/api/auth/me`); solo se non c'è ancora, si legge il viewer.
 */
export async function instancePermissionsNow(): Promise<readonly string[]> {
  if (viewerMe) return viewerMe.instancePermissions as readonly string[];
  return (await getViewer()).instancePermissions as readonly string[];
}

export const getViewer: typeof Fake.getViewer = async () => {
  // La lettura di `getSessionPerson` vale una volta sola (l'avvio): un viewer
  // riletto dopo un cambio di permessi chiede di nuovo `/api/auth/me`.
  const pending = lastMe;
  lastMe = null;
  const me = await (pending ?? appClient().auth.me());
  viewerMe = me;
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
  // Area 9, R5: il primo avvio nella web «app» (`GET /api/auth/setup`, letto da `getSessionPerson`).
  empty: session.empty,
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
  const r =
    input.method === "passkey" ? await web.verifyPasskey() : await web.verifyCode(input.code);
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
 * La conferma del login del desktop (`/#/desktop-login`, Task 21): il
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
    if (error instanceof ApiError && error.code === "reauth_required")
      return { ok: false, error: "reauth_required" };
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
      return {
        ok: false,
        error: "locked",
        lockedUntil: body?.lockedUntil ?? new Date().toISOString(),
      };
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
 *
 * Nell'app desktop (PAT `desktop`, niente cookie) il codice va su
 * `POST /api/auth/desktop-reauth`, che rinfresca la riconferma DEL TOKEN per
 * 10 minuti (decisione del maintainer, 10 nov 2026). Niente passkey dal
 * desktop: il dialogo non la offre, e una richiesta arrivata comunque conta
 * come un codice che non ha funzionato.
 */
const reauthenticate: Auth["reauthenticate"] = async (input: ReauthInput) => {
  const client = appClient();
  if (window.stubwise?.api) {
    if (input.method === "passkey") {
      return { ok: false, error: "invalid_code", triesLeft: SECOND_FACTOR_MAX_FAILURES - 1 };
    }
    try {
      await client.request("POST", "/api/auth/desktop-reauth", { code: input.code.trim() });
      return { ok: true };
    } catch (error) {
      return reauthFailure(error);
    }
  }
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
  // Area 9, F1, R5: le pagine d'ingresso della web «app».
  getResetLink: liveEntry.getResetLink,
  resetPassword: liveEntry.resetPassword,
  createFirstAdmin: liveEntry.createFirstAdmin,
  getInvite: liveEntry.getInvite,
  register: liveEntry.register,
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
    // Area 9, R4b: la sicurezza intera (Preferenze → Security), che serve anche
    // al secondo passo del login e al dialogo di riconferma. Sul desktop le
    // passkey sono vuote: vivono nel browser, e il dialogo non offre «Use a
    // passkey» (decisione del maintainer, 10 nov 2026).
    return await liveMeSecurity.getMySecurity();
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

export const me: Me = partialNamespace<Me>("me", {
  getMySecurity,
  // Area 9, F1, R4a: Preferenze → Account.
  getMyProfile: liveMeAccount.getMyProfile,
  updateProfile: liveMeAccount.updateProfile,
  requestEmailChange: liveMeAccount.requestEmailChange,
  cancelEmailChange: liveMeAccount.cancelEmailChange,
  getEmailChangeLink: liveMeAccount.getEmailChangeLink,
  confirmEmailChange: liveMeAccount.confirmEmailChange,
  changePassword: liveMeAccount.changePassword,
  // Registro, A9 r.1200: le caselle Google in Account, sulle rotte del cassetto.
  ...liveMeMailboxes,
  // Area 9, F1, R4b: Preferenze → Security.
  endSession: liveMeSecurity.endSession,
  startTotpSetup: liveMeSecurity.startTotpSetup,
  confirmTotp: liveMeSecurity.confirmTotp,
  regenerateBackupCodes: liveMeSecurity.regenerateBackupCodes,
  addPasskey: liveMeSecurity.addPasskey,
  renamePasskey: liveMeSecurity.renamePasskey,
  removePasskey: liveMeSecurity.removePasskey,
  // Area 9, F1, R4c: Tokens e Claude Code.
  listTokens: liveMeTokens.listTokens,
  createToken: liveMeTokens.createToken,
  revokeToken: liveMeTokens.revokeToken,
  createClaudeCodeCommand: liveMeTokens.createClaudeCodeCommand,
});
