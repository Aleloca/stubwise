import { isHumanId, reauthRefusal, refuse } from "../admin/common";
import { person as addressOf } from "../seed/mail/helpers";
import { PEOPLE, initials } from "../seed/people";
import { gate, state } from "../store";
import { writer } from "../writer";
import { forgetResetLinksOf } from "../auth/resetPassword";
import { logSecurity } from "./securityLog";
import type { MeResult } from "./types";
import { MIN_PASSWORD_LENGTH, avatarRefusal } from "./accountRules";
export { AVATAR_MAX_BYTES, avatarRefusal } from "./accountRules";
import { emailChangeAvailable, pendingEmailOf, type PendingEmail } from "./emailChange";

export { EMAIL_RE, MIN_PASSWORD_LENGTH } from "./accountRules";

// Account (area 9a, Preferenze personali): nome, email e foto; il cambio
// della password, che chiude le ALTRE sessioni (questa resta, i token
// continuano a valere). Le proprie cose, nessun permesso.
//
// SOLO PROTOTIPO: la password del seme è `stubwise` per tutti (mostrata nel
// riquadro «Prototype only»); una password cambiata sta in
// `state.passwords`, in chiaro, e nessuna lettura la restituisce.

export const SEED_PASSWORD = "stubwise";
/** La password di una persona: quella cambiata, o quella del seme. */
export const passwordOf = (personId: string): string =>
  state.passwords.get(personId) ?? SEED_PASSWORD;

/** L'email d'accesso di una persona, minuscola. */
export const loginEmailOf = (personId: string): string => addressOf(personId).email.toLowerCase();

/** La persona umana con quell'email d'accesso, se c'è. */
export const personByEmail = (email: string): string | null => {
  const wanted = email.trim().toLowerCase();
  return PEOPLE.find((p) => !p.isClaude && loginEmailOf(p.id) === wanted)?.id ?? null;
};

/** Il profilo di chi guarda (Preferenze → Account): l'email è quella d'accesso. */
export interface MyProfile {
  name: string;
  initials: string;
  email: string;
  /** Un data URL, o `null` = le iniziali sul colore del reparto. */
  photo: string | null;
  departmentId: string | null;
  /** Area 9, R2: la richiesta di cambio in attesa di conferma, o `null`. */
  pendingEmail: PendingEmail | null;
  /** Area 9, R2: l'istanza può mandare il link (senza, cambia un admin). */
  emailChangeAvailable: boolean;
}

export async function getMyProfile(): Promise<MyProfile> {
  const me = await gate("me.getMyProfile");
  const person = PEOPLE.find((p) => p.id === me)!;
  return {
    name: person.name,
    initials: person.initials,
    email: loginEmailOf(me),
    photo: person.photo ?? null,
    departmentId: person.departmentIds[0] ?? null,
    pendingEmail: pendingEmailOf(me),
    emailChangeAvailable: emailChangeAvailable(),
  };
}

export interface ProfileInput {
  name?: string;
  /** Un data URL (scelto da un file locale, mai caricato); `null` toglie la foto. */
  avatar?: string | null;
}

/**
 * Cambia nome o foto. Un campo assente resta com'è. Il nome si vede subito
 * ovunque (task, registro, «vedi come»). L'email d'accesso NON cambia da qui
 * (area 9, R2): passa dalla richiesta col link (`emailChange.ts`).
 */
export async function updateProfile(input: ProfileInput): Promise<MeResult> {
  const me = await writer("me.updateProfile");
  if (!isHumanId(me)) return refuse.forbidden();
  const person = PEOPLE.find((p) => p.id === me)!;
  const name = input.name?.trim();
  if (input.name !== undefined && !name) return refuse.invalid("name");
  if (typeof input.avatar === "string") {
    const bad = avatarRefusal(input.avatar);
    if (bad) return refuse.invalid(bad);
  }
  // L'email del seme può derivare dal nome: si fissa prima di cambiarlo.
  person.email ??= addressOf(me).email;
  if (name) Object.assign(person, { name, initials: initials(name) });
  if (input.avatar === null) delete person.photo;
  else if (input.avatar !== undefined) person.photo = input.avatar;
  return { ok: true };
}

/**
 * Cambia la password: serve quella attuale. Chiude le altre sessioni (la
 * lista torna a una, questa) e annulla un link di reset aperto; i token
 * personali continuano a valere.
 */
export async function changePassword(input: {
  current: string;
  next: string;
}): Promise<MeResult<{ signedOut: number }>> {
  const me = await writer("me.changePassword");
  if (!isHumanId(me)) return refuse.forbidden();
  // Area 9: la riconferma, come `config.reauth` di `POST /api/auth/me/password`.
  const reauth = reauthRefusal(me, "me.changePassword");
  if (reauth) return reauth;
  if (input.current !== passwordOf(me)) return refuse.invalid("wrong_password");
  if (input.next.length < MIN_PASSWORD_LENGTH) return refuse.invalid("too_short");
  state.passwords.set(me, input.next);
  // Come `/me/password` del server: un link di reset ancora aperto non vale più.
  forgetResetLinksOf(me);
  const others = state.sessions.filter((s) => s.personId === me && !s.current);
  state.sessions = state.sessions.filter((s) => !others.includes(s));
  logSecurity(me, "password_changed", null);
  return { ok: true, signedOut: others.length };
}
