import { isHumanId, reauthRefusal, refuse, nameOf } from "../admin/common";
import { forgetSecret, matchSecret, storeSecret } from "../admin/secrets";
import { recordChange } from "../changelog/index";
import { person as addressOf } from "../seed/mail/helpers";
import { PEOPLE } from "../seed/people";
import { gate, now, state } from "../store";
import { writer } from "../writer";
import { EMAIL_RE } from "./accountRules";
import { logSecurity, publishSecurityAlert } from "./securityLog";
import type { EmailChange, MeResult } from "./types";

export type { EmailChange } from "./types";

// Il cambio dell'email di login (area 9, R2; design integrazione area 9,
// 1.6, E-1 = a; invariante `identity.md`).
// - La persona chiede, con la riconferma (è l'identità). Il link va al nuovo
//   indirizzo, vale 24 ore e una volta; fino al clic si entra con la VECCHIA.
//   Al clic l'email cambia; sessioni, token e secondo fattore restano. Una
//   seconda richiesta sostituisce la prima; «Annulla» la spegne.
// - Senza trasporto email (SMTP d'istanza facoltativo) la persona non può:
//   `email_transport_unavailable`, e lo fa un admin.
// - Un admin (`users.manage`, riconferma) cambia SUBITO, senza verifica, mai
//   su sé stesso; annulla la richiesta in attesa; l'avviso lo nomina.
// SOLO PROTOTIPO: il link non arriva da nessuna parte. Lo si «apre» dal
// riquadro «Prototype only» (`simulateEmailChangeLink`), e il trasporto si
// spegne da lì (`setEmailTransportForPrototype`).

const LINK_HOURS = 24;

/** La richiesta in attesa di una persona, mostrata nel profilo. */
export interface PendingEmail {
  email: string;
  expiresAt: string;
}

const normal = (email: string) => email.trim().toLowerCase();

const loginEmailOf = (personId: string): string =>
  (PEOPLE.find((p) => p.id === personId)?.email ?? addressOf(personId).email).toLowerCase();

/** Già di un'altra persona, o di un invito ancora valido: lo stesso errore. */
function taken(email: string, personId: string): boolean {
  const byPerson = PEOPLE.some(
    (p) => !p.isClaude && p.id !== personId && loginEmailOf(p.id) === email,
  );
  const byInvite = state.invites.some(
    (i) => normal(i.email) === email && !i.acceptedAt && !i.revokedAt && i.expiresAt > now(),
  );
  return byPerson || byInvite;
}

function pendingOf(personId: string): EmailChange | undefined {
  return state.emailChanges.find((c) => c.personId === personId);
}

function dropPending(personId: string): void {
  const old = pendingOf(personId);
  if (old) forgetSecret(old.secretId);
  state.emailChanges = state.emailChanges.filter((c) => c.personId !== personId);
}

/** Cambia l'email d'accesso: la persona entra con lei da subito. */
function setLoginEmail(personId: string, email: string): void {
  const person = PEOPLE.find((p) => p.id === personId)!;
  person.email = email;
}

export function pendingEmailOf(personId: string): PendingEmail | null {
  const c = pendingOf(personId);
  return c && c.expiresAt > now() ? { email: c.email, expiresAt: c.expiresAt } : null;
}

export function emailChangeAvailable(): boolean {
  return state.emailTransport;
}

/**
 * Senza trasporto email l'istanza non può mandare il link (E-1 = a); con il
 * trasporto, l'invio può non riuscire (502 sul server; nel prototipo no).
 */
export interface MailRefusal {
  ok: false;
  error: "email_transport_unavailable" | "email_send_failed";
}

/** La persona chiede il cambio (+R): il link parte verso il nuovo indirizzo. */
export async function requestEmailChange(
  newEmail: string,
): Promise<MeResult<{ pending: PendingEmail }> | MailRefusal> {
  const me = await writer("me.requestEmailChange");
  if (!isHumanId(me)) return refuse.forbidden();
  const email = normal(newEmail);
  if (!EMAIL_RE.test(email)) return refuse.invalid("email");
  if (email === loginEmailOf(me) || taken(email, me)) return refuse.invalid("email_taken");
  const reauth = reauthRefusal(me, "me.requestEmailChange");
  if (reauth) return reauth;
  if (!state.emailTransport) return { ok: false, error: "email_transport_unavailable" };
  dropPending(me);
  const secret = storeSecret("email_change_link", me);
  const expiresAt = new Date(Date.parse(now()) + LINK_HOURS * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  state.emailChanges.push({
    personId: me,
    email,
    secretId: secret.id,
    createdAt: now(),
    expiresAt,
  });
  return { ok: true, pending: { email, expiresAt } };
}

/** «Annulla»: il link smette di valere. */
export async function cancelEmailChange(): Promise<MeResult> {
  const me = await writer("me.cancelEmailChange");
  dropPending(me);
  return { ok: true };
}

/** Il clic sul link: valido, non scaduto, una volta. Non serve una sessione. */
function confirm(change: EmailChange | undefined): MeResult<{ email: string }> {
  if (!change || change.expiresAt <= now()) return refuse.invalid("link");
  const { personId, email } = change;
  dropPending(personId);
  // Nel frattempo l'indirizzo può essere stato preso.
  if (taken(email, personId)) return refuse.invalid("email_taken");
  setLoginEmail(personId, email);
  logSecurity(personId, "email_changed", null);
  publishSecurityAlert(
    personId,
    "Sign-in email changed",
    `Your sign-in email is now ${email}. If it wasn't you, contact an administrator.`,
  );
  return { ok: true, email };
}

/**
 * La pagina del link lo LEGGE prima di confermare: aprirlo non cambia
 * niente (gli scanner della posta aprono i link ed eseguono il JS), si
 * conferma solo col clic. Sbagliato, scaduto, usato o annullato: `invalid`,
 * senza dire quale né di chi.
 */
export async function getEmailChangeLink(
  token: string,
): Promise<{ status: "valid"; email: string } | { status: "invalid" }> {
  await gate("auth.getEmailChangeLink");
  const hit = matchSecret("email_change_link", token.trim());
  const change = hit ? state.emailChanges.find((c) => c.secretId === hit.id) : undefined;
  return change && change.expiresAt > now()
    ? { status: "valid", email: change.email }
    : { status: "invalid" };
}

/** La conferma, col clic sulla pagina del link (`<PUBLIC_URL>/#/email-change/<token>`). */
export async function confirmEmailChange(token: string): Promise<MeResult<{ email: string }>> {
  await gate("auth.confirmEmailChange");
  const hit = matchSecret("email_change_link", token.trim());
  return confirm(hit ? state.emailChanges.find((c) => c.secretId === hit.id) : undefined);
}

/** SOLO PROTOTIPO: «Apri il link di conferma» dal riquadro, per chi guarda. */
export async function simulateEmailChangeLink(): Promise<MeResult<{ email: string }>> {
  const me = await writer("me.simulateEmailChangeLink");
  return confirm(pendingOf(me));
}

/** SOLO PROTOTIPO: l'istanza ha (o non ha) un trasporto email. */
export function setEmailTransportForPrototype(on: boolean): void {
  state.emailTransport = on;
}

/**
 * Un admin cambia l'email di un'altra persona (+R, `users.manage`): subito,
 * senza verifica, mai su sé stesso. Annulla la richiesta in attesa.
 */
export async function adminChangeEmail(
  me: string,
  personId: string,
  newEmail: string,
): Promise<MeResult> {
  if (personId === me) return refuse.invalid("self");
  const email = normal(newEmail);
  if (!EMAIL_RE.test(email)) return refuse.invalid("email");
  if (email === loginEmailOf(personId) || taken(email, personId))
    return refuse.invalid("email_taken");
  const reauth = reauthRefusal(me, "admin.changeEmail");
  if (reauth) return reauth;
  dropPending(personId);
  setLoginEmail(personId, email);
  logSecurity(personId, "email_changed", me);
  publishSecurityAlert(
    personId,
    "Sign-in email changed",
    `${nameOf(me)} changed your sign-in email to ${email}. If you didn't expect it, ask them why.`,
  );
  recordChange({
    kind: "person.email_changed",
    actorId: me,
    projectId: null,
    object: { type: "person", id: personId, label: nameOf(personId) ?? personId },
  });
  return { ok: true };
}
