import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { and, eq, sql } from "drizzle-orm";
import { sessions, userPasskeys, type Db } from "@stubwise/db";

/**
 * Passkey (WebAuthn) come secondo fattore, solo web. Il relying party è
 * l'istanza stessa: `rpID` = hostname di `PUBLIC_URL`, `origin` = la sua
 * origin. Un cambio di dominio rende inutilizzabili le passkey registrate
 * prima (il browser le lega all'rpID): restano TOTP e codici di riserva.
 */
export interface PasskeyRp {
  rpID: string;
  rpName: "Stubwise";
  origin: string;
}

export function passkeyRp(publicUrl: string): PasskeyRp {
  const url = new URL(publicUrl);
  return { rpID: url.hostname, rpName: "Stubwise", origin: url.origin };
}

/**
 * Le passkey non chiedono la verifica dell'utente (PIN, biometria): sono il
 * SECONDO fattore, dopo la password. «preferred» la fa fare dove c'è, la
 * verifica non la pretende.
 */
const USER_VERIFICATION = "preferred" as const;

async function passkeysOf(db: Db, userId: string) {
  return db
    .select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));
}

async function saveChallenge(db: Db, sessionId: string, challenge: string): Promise<void> {
  await db.update(sessions).set({ webauthnChallenge: challenge }).where(eq(sessions.id, sessionId));
}

/**
 * Prende E cancella la challenge della sessione in un colpo solo: monouso
 * anche con due verifiche in parallelo (una sola la legge), e cancellata
 * qualunque sia l'esito della verifica che segue.
 */
async function takeChallenge(db: Db, sessionId: string): Promise<string | null> {
  const rows = await db.execute<{ challenge: string | null }>(sql`
    update ${sessions} s
       set webauthn_challenge = null
      from (select id, webauthn_challenge from ${sessions} where id = ${sessionId} for update) old
     where s.id = old.id
    returning old.webauthn_challenge as challenge
  `);
  return rows[0]?.challenge ?? null;
}

/**
 * Opzioni per `navigator.credentials.create()`: esclude le passkey già
 * registrate dall'utente (il browser non ne crea un doppione sullo stesso
 * autenticatore) e salva la challenge sulla sessione.
 */
export async function registrationOptions(
  db: Db,
  sessionId: string,
  user: { id: string; email: string },
  rp: PasskeyRp,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await passkeysOf(db, user.id);
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: USER_VERIFICATION },
  });
  await saveChallenge(db, sessionId, options.challenge);
  return options;
}

/**
 * Chiude una registrazione: verifica la risposta contro la challenge della
 * sessione (consumata comunque) e salva la passkey. `null` se la verifica
 * non passa, se la challenge non c'è, o se la credenziale è già registrata.
 */
export async function finishRegistration(
  db: Db,
  sessionId: string,
  userId: string,
  name: string,
  response: RegistrationResponseJSON,
  rp: PasskeyRp,
): Promise<{ id: string } | null> {
  const challenge = await takeChallenge(db, sessionId);
  if (!challenge) return null;
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch {
    // La libreria lancia su ogni risposta che non torna (origin, challenge,
    // formato): per chi chiama è una registrazione non riuscita.
    return null;
  }
  if (!verification.verified) return null;
  const { credential } = verification.registrationInfo;
  const [row] = await db
    .insert(userPasskeys)
    .values({
      userId,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: response.response.transports ?? credential.transports ?? [],
      name: name.trim(),
    })
    .onConflictDoNothing({ target: userPasskeys.credentialId })
    .returning({ id: userPasskeys.id });
  return row ?? null;
}

/**
 * Opzioni per `navigator.credentials.get()`: le sole passkey dell'utente e
 * la challenge salvata sulla sessione.
 */
export async function authenticationOptions(
  db: Db,
  sessionId: string,
  userId: string,
  rp: PasskeyRp,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const existing = await passkeysOf(db, userId);
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    userVerification: USER_VERIFICATION,
  });
  await saveChallenge(db, sessionId, options.challenge);
  return options;
}

/**
 * Verifica l'uso di una passkey: la credenziale deve essere DELL'utente, la
 * firma valida sulla challenge della sessione (consumata comunque), origin e
 * rpID quelli dell'istanza, il contatore in salita. Se passa aggiorna
 * contatore e ultimo uso. Non tocca il tetto dei tentativi: lo fa il
 * chiamante (`attemptSecondFactor`).
 */
export async function finishAuthentication(
  db: Db,
  sessionId: string,
  userId: string,
  response: AuthenticationResponseJSON,
  rp: PasskeyRp,
): Promise<boolean> {
  const challenge = await takeChallenge(db, sessionId);
  if (!challenge) return false;
  const [passkey] = await db
    .select()
    .from(userPasskeys)
    .where(and(eq(userPasskeys.credentialId, response.id), eq(userPasskeys.userId, userId)));
  if (!passkey) return false;
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: isoBase64URL.toBuffer(passkey.publicKey),
        counter: passkey.counter,
        transports: passkey.transports,
      },
      requireUserVerification: false,
    });
  } catch {
    return false;
  }
  if (!verification.verified) return false;
  await db
    .update(userPasskeys)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: sql`now()` })
    .where(eq(userPasskeys.id, passkey.id));
  return true;
}
