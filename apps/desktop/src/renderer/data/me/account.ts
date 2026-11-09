import { isHumanId, refuse } from "../admin/common";
import { person as addressOf } from "../seed/mail/helpers";
import { PEOPLE, initials } from "../seed/people";
import { gate, state } from "../store";
import { writer } from "../writer";
import { forgetResetLinksOf } from "../auth/resetPassword";
import { logSecurity } from "./securityLog";
import type { MeResult } from "./types";

// Account (area 9a, Preferenze personali): nome, email e foto; il cambio
// della password, che chiude le ALTRE sessioni (questa resta, i token
// continuano a valere). Le proprie cose, nessun permesso.
//
// SOLO PROTOTIPO: la password del seme è `stubwise` per tutti (mostrata nel
// riquadro «Prototype only»); una password cambiata sta in
// `state.passwords`, in chiaro, e nessuna lettura la restituisce.

export const SEED_PASSWORD = "stubwise";
export const MIN_PASSWORD_LENGTH = 8;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  };
}

export interface ProfileInput {
  name?: string;
  email?: string;
  /** Un data URL (scelto da un file locale, mai caricato); `null` toglie la foto. */
  avatar?: string | null;
}

/**
 * Cambia nome, email o foto. Un campo assente resta com'è. L'email nuova
 * dev'essere valida e di nessun altro; diventa quella d'accesso. Il nome si
 * vede subito ovunque (task, registro, «vedi come»).
 */
export async function updateProfile(input: ProfileInput): Promise<MeResult> {
  const me = await writer("me.updateProfile");
  if (!isHumanId(me)) return refuse.forbidden();
  const person = PEOPLE.find((p) => p.id === me)!;
  const name = input.name?.trim();
  if (input.name !== undefined && !name) return refuse.invalid("name");
  const email = input.email?.trim().toLowerCase();
  if (input.email !== undefined) {
    if (!email || !EMAIL_RE.test(email)) return refuse.invalid("email");
    const owner = personByEmail(email);
    if (owner && owner !== me) return refuse.invalid("email_taken");
  }
  // L'email del seme può derivare dal nome: si fissa prima di cambiarlo.
  person.email ??= addressOf(me).email;
  if (name) Object.assign(person, { name, initials: initials(name) });
  if (email) person.email = email;
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
