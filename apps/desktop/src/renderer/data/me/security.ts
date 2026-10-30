import { accessState, writeAccess, type PersonAccess } from "../access/index";
import { isHumanId, nameOf, reauthRefusal, refuse } from "../admin/common";
import { BACKUP_CODE_COUNT, forgetSecret, secretIdsOf, storeSecret } from "../admin/secrets";
import {
  attemptPendingTotp,
  markReauthenticated,
  newTotpSetup,
  pendingTotpIds,
  type SecondFactorResult,
  type TotpSetup,
} from "../auth/reauth";
import { copy, gate, newId, now, state } from "../store";
import { writer } from "../writer";
import { logSecurity, publishSecurityAlert } from "./securityLog";
import type { MeResult, MySecurity } from "./types";

// Sicurezza (area 9a, Preferenze personali): l'app di autenticazione, le
// passkey, i codici di backup, le sessioni aperte e il registro personale.
// Il secondo fattore non si spegne: si sostituisce un metodo, non lo si
// toglie (come il web). Le azioni delicate sono dichiarate in
// `REAUTH_REQUIRED` (`auth/reauth.ts`): configurare l'app, aggiungere e
// togliere una passkey, rigenerare i codici. La chiave TOTP e i codici di
// backup escono una volta, nel risultato che li crea.

const EVENTS_DAYS = 90;
const NAME_MAX = 60;

const accessOf = (personId: string): PersonAccess | undefined =>
  accessState().people.find((p) => p.personId === personId);

/** Lo stato del secondo fattore di chi guarda, le sessioni e il registro (90 giorni). */
export async function getMySecurity(): Promise<MySecurity> {
  const me = await gate("me.getMySecurity");
  const sf = accessOf(me)?.secondFactor ?? null;
  const since = Date.parse(now()) - EVENTS_DAYS * 86_400_000;
  const events = state.securityEvents
    .filter((e) => e.personId === me && Date.parse(e.at) >= since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const totpSince =
    events.find((e) => e.kind === "second_factor_enabled" || e.kind === "authenticator_changed")
      ?.at ?? null;
  return {
    on: sf?.totp ?? false,
    totp: sf?.totp ?? false,
    totpSince: sf ? totpSince : null,
    passkeys: state.passkeys
      .filter((k) => k.personId === me)
      .map((k) => ({ id: k.id, name: k.name, addedAt: k.addedAt, lastUsedAt: k.lastUsedAt })),
    backupCodesLeft: sf?.backupCodesLeft ?? 0,
    backupCodesTotal: BACKUP_CODE_COUNT,
    sessions: state.sessions
      .filter((s) => s.personId === me)
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || b.lastUsedAt.localeCompare(a.lastUsedAt),
      )
      .map((s) => ({
        id: s.id,
        device: copy(s.device),
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        current: s.current,
      })),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      at: e.at,
      byId: e.byId,
      byName: nameOf(e.byId),
    })),
  };
}

/**
 * Configura (o riconfigura) l'app di autenticazione (+R): la chiave e il QR,
 * una volta. Finché non si conferma col primo codice, l'app di prima resta
 * valida.
 */
export async function startTotpSetup(): Promise<MeResult<{ setup: TotpSetup }>> {
  const me = await writer("me.startTotpSetup");
  if (!isHumanId(me)) return refuse.forbidden();
  const reauth = reauthRefusal(me, "me.startTotpSetup");
  if (reauth) return reauth;
  return { ok: true, setup: newTotpSetup(me) };
}

/** Il numero di passkey nello stato degli accessi segue l'elenco: scritti insieme. */
function syncPasskeyCount(personId: string): void {
  const n = state.passkeys.filter((k) => k.personId === personId).length;
  writeAccess((s) => {
    const p = s.people.find((x) => x.personId === personId);
    if (p?.secondFactor) p.secondFactor.passkeys = n;
  });
}

/** Sostituisce i codici di backup: i vecchi smettono di valere; i nuovi, una volta. */
function freshBackupCodes(personId: string): string[] {
  for (const id of secretIdsOf("backup_codes", personId)) forgetSecret(id);
  return storeSecret("backup_codes", personId).value.split("\n");
}

export type ConfirmTotpResult =
  | { ok: true; backupCodes: string[] | null }
  | Exclude<SecondFactorResult, { ok: true } | { error: "no_second_factor" }>
  | Extract<MeResult, { ok: false }>;

/**
 * Conferma l'app in attesa col primo codice (sotto il tetto dei tentativi).
 * Alla prima attivazione il secondo fattore si accende e arrivano i 10
 * codici di backup, una volta; in una riconfigurazione la chiave nuova
 * sostituisce la vecchia (`backupCodes: null`). In entrambi i casi la
 * sessione conta come riconfermata (`second-factor.md`).
 */
export async function confirmTotp(code: string): Promise<ConfirmTotpResult> {
  const me = await writer("me.confirmTotp");
  if (!isHumanId(me)) return refuse.forbidden();
  const pending = pendingTotpIds(me);
  if (pending.length === 0) return refuse.invalid("no_pending");
  const result = attemptPendingTotp(me, code);
  if (!result.ok) return result as ConfirmTotpResult;
  const old = state.confirmedTotp.get(me);
  if (old) forgetSecret(old);
  state.confirmedTotp.set(me, pending.at(-1)!);
  const first = accessOf(me)!.secondFactor === null;
  const backupCodes = first ? freshBackupCodes(me) : null;
  const passkeys = state.passkeys.filter((k) => k.personId === me).length;
  writeAccess((s) => {
    const p = s.people.find((x) => x.personId === me)!;
    p.secondFactor = first
      ? { totp: true, passkeys, backupCodesLeft: backupCodes!.length }
      : { ...p.secondFactor!, totp: true };
  });
  logSecurity(me, first ? "second_factor_enabled" : "authenticator_changed", null);
  markReauthenticated(me);
  return { ok: true, backupCodes };
}

const passkeyName = (name: string): string | null => {
  const value = name.trim();
  return value && value.length <= NAME_MAX ? value : null;
};

/**
 * Aggiunge una passkey (+R). Serve un secondo fattore già attivo (la passkey
 * è un di più: il TOTP è obbligatorio). Nel prototipo il browser risponde con
 * `simulate` («Simulate passkey» / «Simulate a failed passkey»).
 */
export async function addPasskey(
  name: string,
  simulate: "ok" | "fail" = "ok",
): Promise<MeResult<{ passkeyId: string }>> {
  const me = await writer("me.addPasskey");
  if (!isHumanId(me)) return refuse.forbidden();
  const value = passkeyName(name);
  if (!value) return refuse.invalid("name");
  if (!accessOf(me)!.secondFactor) return refuse.invalid("no_second_factor");
  const reauth = reauthRefusal(me, "me.addPasskey");
  if (reauth) return reauth;
  if (simulate === "fail") return refuse.invalid("passkey_failed");
  const id = newId("pk");
  state.passkeys.push({ id, personId: me, name: value, addedAt: now(), lastUsedAt: null });
  syncPasskeyCount(me);
  logSecurity(me, "passkey_added", null);
  publishSecurityAlert(
    me,
    "Passkey added",
    `A passkey named “${value}” was added to your account. If it wasn't you, remove it and change your password.`,
  );
  return { ok: true, passkeyId: id };
}

/** Rinomina una mia passkey (senza riconferma). */
export async function renamePasskey(id: string, name: string): Promise<MeResult> {
  const me = await writer("me.renamePasskey");
  const key = state.passkeys.find((k) => k.id === id && k.personId === me);
  if (!key) return refuse.notFound();
  const value = passkeyName(name);
  if (!value) return refuse.invalid("name");
  key.name = value;
  return { ok: true };
}

/**
 * Toglie una mia passkey (+R). L'ultimo metodo non si toglie: senza l'app di
 * autenticazione l'ultima passkey resta (il secondo fattore non si spegne).
 */
export async function removePasskey(id: string): Promise<MeResult> {
  const me = await writer("me.removePasskey");
  const key = state.passkeys.find((k) => k.id === id && k.personId === me);
  if (!key) return refuse.notFound();
  const mine = state.passkeys.filter((k) => k.personId === me);
  if (mine.length === 1 && !accessOf(me)!.secondFactor?.totp) return refuse.invalid("last_method");
  const reauth = reauthRefusal(me, "me.removePasskey");
  if (reauth) return reauth;
  state.passkeys = state.passkeys.filter((k) => k.id !== id);
  syncPasskeyCount(me);
  logSecurity(me, "passkey_removed", null);
  return { ok: true };
}

/** Rigenera i codici di backup (+R): i vecchi smettono subito di valere; i 10 nuovi, una volta. */
export async function regenerateBackupCodes(): Promise<MeResult<{ codes: string[] }>> {
  const me = await writer("me.regenerateBackupCodes");
  if (!isHumanId(me)) return refuse.forbidden();
  if (!accessOf(me)!.secondFactor) return refuse.invalid("no_second_factor");
  const reauth = reauthRefusal(me, "me.regenerateBackupCodes");
  if (reauth) return reauth;
  const codes = freshBackupCodes(me);
  writeAccess((s) => {
    s.people.find((x) => x.personId === me)!.secondFactor!.backupCodesLeft = codes.length;
  });
  logSecurity(me, "backup_codes_regenerated", null);
  publishSecurityAlert(
    me,
    "Backup codes replaced",
    "New backup codes were made for your account; the previous ones no longer work. If it wasn't you, change your password.",
  );
  return { ok: true, codes };
}

/** «Sign out» da un'altra mia sessione. Questa si chiude con «Esci» (`logout`). */
export async function endSession(id: string): Promise<MeResult> {
  const me = await writer("me.endSession");
  const session = state.sessions.find((s) => s.id === id && s.personId === me);
  if (!session) return refuse.notFound();
  if (session.current) return refuse.invalid("current");
  state.sessions = state.sessions.filter((s) => s.id !== id);
  logSecurity(me, "session_ended", null);
  return { ok: true };
}
