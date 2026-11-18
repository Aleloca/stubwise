import { createHash, randomBytes } from "node:crypto";
import { emailChanges, invites, users, type Db } from "@stubwise/db";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { publishSecurityAlert } from "../auth/second-factor/alerts.js";
import { recordSecurityEvent } from "../auth/second-factor/security-events.js";
import { personObject, recordChange } from "./change-log.js";
import type { MailTransport } from "../mail/transport.js";

/**
 * Area 9, F1 (D-13, E-1 = a; docs/invariants/identity.md, «L'email di login
 * cambia solo dopo il clic sul link mandato alla NUOVA»).
 * - La richiesta (con la riconferma, la impone la rotta) manda il link alla
 *   nuova e l'avviso alla vecchia; vale 24 ore; il token è monouso e si salva
 *   come hash; al più una richiesta pendente (una nuova sostituisce la prima).
 * - Al clic, in UNA transazione: l'email cambia, `email_changed` in
 *   `security_events`, `security.alert` all'interessato. Sessioni, token e
 *   secondo fattore restano intatti. Le caselle Google e le identità git e
 *   Slack non cambiano.
 * - Il cambio fatto da un admin (`users.manage`, riconferma) è subito, senza
 *   verifica, mai su sé stessi; annulla la richiesta pendente; l'avviso nomina
 *   l'admin.
 * Un'email già di un'altra persona o di un invito pendente: lo stesso 409.
 */

export const EMAIL_CHANGE_TTL_MS = 24 * 3_600_000;

export class EmailChangeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const normalize = (email: string) => email.trim().toLowerCase();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const taken = () => new EmailChangeError(409, "email_taken", "This email cannot be used");
const pendingWhere = (userId: string) => and(eq(emailChanges.userId, userId), isNull(emailChanges.confirmedAt), isNull(emailChanges.cancelledAt));

type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const isUniqueViolation = (error: unknown): boolean => {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

async function emailInUse(db: DbOrTx, email: string, exceptUserId: string): Promise<boolean> {
  const [user] = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${email}`, ne(users.id, exceptUserId))).limit(1);
  if (user) return true;
  // Solo un invito ANCORA valido tiene l'indirizzo: uno scaduto no.
  const [invite] = await db
    .select({ token: invites.token })
    .from(invites)
    .where(and(sql`lower(${invites.email}) = ${email}`, gt(invites.expiresAt, new Date())))
    .limit(1);
  return invite !== undefined;
}

export interface EmailChangeStatus {
  available: boolean;
  pending: { newEmail: string; expiresAt: string } | null;
}

export async function emailChangeStatus(db: Db, transport: MailTransport, userId: string): Promise<EmailChangeStatus> {
  const [row] = await db
    .select({ newEmail: emailChanges.newEmail, expiresAt: emailChanges.expiresAt })
    .from(emailChanges)
    .where(and(pendingWhere(userId), gt(emailChanges.expiresAt, new Date())));
  return { available: transport.isConfigured(), pending: row ? { newEmail: row.newEmail, expiresAt: row.expiresAt.toISOString() } : null };
}

export async function requestEmailChange(
  db: Db,
  transport: MailTransport,
  publicUrl: string,
  user: { id: string; email: string },
  rawEmail: string,
): Promise<EmailChangeStatus> {
  if (!transport.isConfigured()) throw new EmailChangeError(409, "email_transport_unavailable", "Email change is not available on this instance");
  const newEmail = normalize(rawEmail);
  if (newEmail === normalize(user.email) || (await emailInUse(db, newEmail, user.id))) throw taken();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);
  const id = await db.transaction(async (tx) => {
    await tx.update(emailChanges).set({ cancelledAt: new Date() }).where(pendingWhere(user.id));
    const [row] = await tx.insert(emailChanges).values({ userId: user.id, newEmail, tokenHash: hashToken(token), expiresAt }).returning({ id: emailChanges.id });
    return row!.id;
  });
  try {
    await transport.send({
      to: newEmail,
      subject: "Confirm your new Stubwise sign-in email",
      text: `Someone asked to use this address to sign in to Stubwise (${publicUrl}).\n\nTo confirm, open this link within 24 hours:\n${publicUrl}/app/#/email-change/${token}\n\nIf it was not you, ignore this email.`,
    });
    await transport.send({
      to: user.email,
      subject: "Your Stubwise sign-in email is about to change",
      text: `A change of your Stubwise sign-in email to ${newEmail} was requested. It happens only when the link sent to the new address is opened.\n\nIf it was not you, tell an admin.`,
    });
  } catch {
    // Un link che non è partito non resta in attesa.
    await db.delete(emailChanges).where(eq(emailChanges.id, id));
    throw new EmailChangeError(502, "email_send_failed", "The confirmation email could not be sent");
  }
  return { available: true, pending: { newEmail, expiresAt: expiresAt.toISOString() } };
}

export async function cancelEmailChange(db: Db, userId: string): Promise<void> {
  await db.update(emailChanges).set({ cancelledAt: new Date() }).where(pendingWhere(userId));
}

/**
 * Legge un link senza confermarlo (gli scanner della posta aprono i link ed
 * eseguono il JS: la pagina conferma solo col bottone). Una sola risposta per
 * sbagliato, scaduto, usato o annullato, e non dice di chi è.
 */
export async function peekEmailChange(db: Db, token: string): Promise<{ status: "valid"; newEmail: string } | { status: "invalid" }> {
  const [row] = await db
    .select({ newEmail: emailChanges.newEmail })
    .from(emailChanges)
    .innerJoin(users, eq(users.id, emailChanges.userId))
    .where(
      and(
        eq(emailChanges.tokenHash, hashToken(token)),
        isNull(emailChanges.confirmedAt),
        isNull(emailChanges.cancelledAt),
        gt(emailChanges.expiresAt, new Date()),
        isNull(users.deactivatedAt),
      ),
    );
  return row ? { status: "valid", newEmail: row.newEmail } : { status: "invalid" };
}

const invalidToken = () => new EmailChangeError(400, "invalid_token", "Invalid or expired link");

export async function confirmEmailChange(db: Db, transport: MailTransport, token: string): Promise<{ email: string }> {
  const result = await db.transaction(async (tx) => {
    const [change] = await tx
      .select()
      .from(emailChanges)
      .where(and(eq(emailChanges.tokenHash, hashToken(token)), isNull(emailChanges.confirmedAt), isNull(emailChanges.cancelledAt), gt(emailChanges.expiresAt, new Date())))
      .for("update");
    if (!change) throw invalidToken();
    const [user] = await tx.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.id, change.userId), isNull(users.deactivatedAt))).for("update");
    if (!user) throw invalidToken();
    // Fra la richiesta e il clic qualcun altro può aver preso l'indirizzo.
    if (await emailInUse(tx, change.newEmail, user.id)) throw taken();
    try {
      // Un savepoint: un'altra conferma sullo stesso indirizzo può vincere la
      // corsa fra il controllo qui sopra e l'UPDATE (l'indice unico la ferma).
      await tx.transaction(async (sp) => sp.update(users).set({ email: change.newEmail }).where(eq(users.id, user.id)));
    } catch (error) {
      if (isUniqueViolation(error)) throw taken();
      throw error;
    }
    await tx.update(emailChanges).set({ confirmedAt: new Date() }).where(eq(emailChanges.id, change.id));
    await recordSecurityEvent(tx, { kind: "email_changed", user: { id: user.id, email: change.newEmail }, detail: `${user.email} → ${change.newEmail}` });
    // Area 9, F2: l'attore è la persona stessa, che ha aperto il link.
    await recordChange(tx, { type: "person.email_changed", actor: { id: user.id, email: change.newEmail }, projectId: null, data: { object: personObject(user), before: user.email, after: change.newEmail } });
    await publishSecurityAlert(tx, user.id, "email_changed", null);
    return { oldEmail: user.email, email: change.newEmail };
  });
  await notifyOld(transport, result.oldEmail, result.email, null);
  return { email: result.email };
}

export async function adminChangeEmail(
  db: Db,
  transport: MailTransport,
  actor: { id: string; email: string },
  userId: string,
  rawEmail: string,
): Promise<{ email: string }> {
  if (userId === actor.id) throw new EmailChangeError(400, "cannot_change_own_email", "Change your own email from your preferences");
  const email = normalize(rawEmail);
  const result = await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id, email: users.email, isAgent: users.isAgent }).from(users).where(eq(users.id, userId)).for("update");
    if (!user || user.isAgent) throw new EmailChangeError(404, "user_not_found", "User not found");
    if (email === normalize(user.email) || (await emailInUse(tx, email, user.id))) throw taken();
    await tx.update(users).set({ email }).where(eq(users.id, user.id));
    await tx.update(emailChanges).set({ cancelledAt: new Date() }).where(pendingWhere(user.id));
    await recordSecurityEvent(tx, { kind: "email_changed", user: { id: user.id, email }, actor, detail: `${user.email} → ${email}` });
    await recordChange(tx, { type: "person.email_changed", actor, projectId: null, data: { object: personObject(user), before: user.email, after: email } });
    await publishSecurityAlert(tx, user.id, "email_changed", actor.email);
    return { oldEmail: user.email, email };
  });
  await notifyOld(transport, result.oldEmail, result.email, actor.email);
  return { email: result.email };
}

/** L'avviso alla vecchia email, dopo il cambio: best effort, il cambio è già fatto. */
async function notifyOld(transport: MailTransport, oldEmail: string, newEmail: string, actorEmail: string | null): Promise<void> {
  if (!transport.isConfigured()) return;
  try {
    await transport.send({
      to: oldEmail,
      subject: "Your Stubwise sign-in email was changed",
      text: `Your Stubwise sign-in email is now ${newEmail}${actorEmail ? ` (changed by ${actorEmail})` : ""}.\n\nIf it was not you, tell an admin.`,
    });
  } catch {
    // Il cambio resta; l'avviso in Stubwise (security.alert) c'è comunque.
  }
}
