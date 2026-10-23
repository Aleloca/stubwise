import {
  credentialRecipientsSchema,
  credentialSharePreviewSchema,
  type CredentialKeyCopyInput,
} from "@stubwise/shared";
import type { VaultActorProof, VaultRecoveryKeyPreview } from "@stubwise/shared";
import {
  decryptPassword,
  encryptForInsert,
  openActorChallenge,
  unwrapItemKey,
  wrapItemKey,
} from "@stubwise/vault-crypto";
import {
  ApiError,
  postVaultActorChallenge,
  revealCredential,
  type CredentialRecipients,
  type CredentialSharePreview,
} from "../api";
import { VaultError } from "./unlock";

/**
 * Le operazioni cifrate sulle credenziali (design «Il modello delle
 * chiavi», «Mostrare e copiare»). Nessuna funzione qui mette un segreto
 * (password, chiave d'oggetto, chiave privata) in una cache, in un log o
 * nello storage del browser: la password in chiaro esce solo come valore di
 * ritorno, per lo stato del componente che la mostra o per gli appunti.
 */

/**
 * L'id di una credenziale nuova: lo genera il client perché è l'AAD della
 * password cifrata e delle copie. `crypto.randomUUID()` esiste solo nei
 * contesti sicuri; `getRandomValues` ovunque — stesso formato (v4).
 */
export function newCredentialId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** La chiave aperta nella scheda: la privata (non estraibile) e il suo id. */
export interface OpenKey {
  privateKey: CryptoKey;
  personKeyId: string;
}

/**
 * La prova di possesso della propria chiave (review finale della cassaforte):
 * il server cifra un segreto per la chiave CONFERMATA di chi chiede, il
 * browser lo apre con la privata in memoria e lo rimanda. Una per azione
 * (il server la consuma). Se la sfida è per un'altra chiave (ricreata in
 * un'altra scheda) → `stale_key`; se non si apre → `open_failed`.
 */
export async function proveKey(key: OpenKey): Promise<VaultActorProof> {
  const challenge = await postVaultActorChallenge();
  if (challenge.personKeyId !== key.personKeyId) throw new VaultError("stale_key");
  try {
    return {
      challengeId: challenge.challengeId,
      proof: await openActorChallenge(challenge.wrapped, key.privateKey, challenge.challengeId, key.personKeyId),
    };
  } catch {
    throw new VaultError("open_failed");
  }
}

/** Il corpo cifrato di una creazione o di un cambio password. */
export interface EncryptedPassword {
  passwordCiphertext: string;
  copies: CredentialKeyCopyInput[];
  recoveryPublicKey: string;
}

/** Cifra la password per ESATTAMENTE i destinatari dati: le persone e il recupero. */
export async function encryptForRecipients(
  credentialId: string,
  password: string,
  recipients: CredentialRecipients,
): Promise<EncryptedPassword> {
  const { passwordCiphertext, copies } = await encryptForInsert({
    credentialId,
    password,
    recipients: [
      ...recipients.people.map((person) => ({
        recipientId: person.personKeyId,
        publicKey: person.publicKey,
      })),
      { recipientId: "recovery", publicKey: recipients.recoveryPublicKey },
    ],
  });
  return { passwordCiphertext, copies, recoveryPublicKey: recipients.recoveryPublicKey };
}

/** I destinatari attuali portati da un 409 `recipients_changed`, o `null`. */
function changedRecipients(cause: unknown): CredentialRecipients | null {
  if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "recipients_changed")
    return null;
  const parsed = credentialRecipientsSchema.safeParse(
    (cause.details as { recipients?: unknown } | undefined)?.recipients,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Cifra e scrive (creazione o cambio password). Se fra la lettura dei
 * destinatari e la scrittura l'insieme è cambiato (un admin aggiunto, una
 * chiave confermata, il kit rigenerato), il server risponde 409
 * `recipients_changed` con i destinatari ATTUALI: si ricifra per quelli e
 * si riprova UNA volta. Un secondo 409 sale al chiamante.
 */
export async function writeEncrypted<T>(input: {
  credentialId: string;
  password: string;
  loadRecipients: () => Promise<CredentialRecipients>;
  write: (body: EncryptedPassword) => Promise<T>;
}): Promise<T> {
  const first = await input.loadRecipients();
  try {
    return await input.write(await encryptForRecipients(input.credentialId, input.password, first));
  } catch (cause) {
    const current = changedRecipients(cause);
    if (!current) throw cause;
    return input.write(await encryptForRecipients(input.credentialId, input.password, current));
  }
}

/**
 * Mostra o copia: scarica (registrato) password cifrata e propria copia
 * della chiave, apre la copia con la chiave privata della cassaforte aperta
 * e decifra. La chiave d'oggetto non esce da qui.
 */
export async function revealPassword(
  credentialId: string,
  action: "show" | "copy",
  privateKey: CryptoKey,
): Promise<string> {
  const revealed = await revealCredential(credentialId, action);
  const itemKey = await unwrapItemKey(
    revealed.wrappedKey,
    privateKey,
    credentialId,
    revealed.personKeyId,
  );
  return decryptPassword(credentialId, revealed.passwordCiphertext, itemKey);
}

/** L'anteprima attuale portata da un 409 `recipients_changed` di una condivisione, o `null`. */
function changedPreview(cause: unknown): CredentialSharePreview | null {
  if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "recipients_changed")
    return null;
  const parsed = credentialSharePreviewSchema.safeParse(
    (cause.details as { preview?: unknown } | undefined)?.preview,
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Le copie di una condivisione: apre la PROPRIA copia della chiave
 * (`preview.wrappedKey`, cifrata per la chiave di persona di chi condivide)
 * e la ricifra per ogni persona con chiave confermata dell'anteprima.
 */
async function shareCopies(
  credentialId: string,
  preview: CredentialSharePreview,
  privateKey: CryptoKey,
  personKeyId: string,
): Promise<{ copies: CredentialKeyCopyInput[]; keyVersion: string }> {
  const itemKey = await unwrapItemKey(preview.wrappedKey, privateKey, credentialId, personKeyId);
  const copies = await Promise.all(
    preview.people.map(async (person) => ({
      recipientId: person.personKeyId,
      wrappedKey: await wrapItemKey(itemKey, person.publicKey, credentialId, person.personKeyId),
    })),
  );
  return { copies, keyVersion: preview.keyVersion };
}

/**
 * Condivide con una persona o un ruolo: anteprima → copie → scrittura, con
 * la prova della propria chiave (una per tentativo: il server la consuma).
 * Su 409 `recipients_changed` (persone cambiate, password cambiata nel
 * frattempo) ricifra dall'anteprima attuale e riprova UNA volta.
 */
export async function shareEncrypted<T>(input: {
  credentialId: string;
  privateKey: CryptoKey;
  personKeyId: string;
  loadPreview: () => Promise<CredentialSharePreview>;
  write: (body: { copies: CredentialKeyCopyInput[]; keyVersion: string; actorProof: VaultActorProof }) => Promise<T>;
}): Promise<T> {
  const key = { privateKey: input.privateKey, personKeyId: input.personKeyId };
  const attempt = async (preview: CredentialSharePreview) => {
    const body = await shareCopies(input.credentialId, preview, input.privateKey, input.personKeyId);
    return input.write({ ...body, actorProof: await proveKey(key) });
  };
  const first = await input.loadPreview();
  try {
    return await attempt(first);
  } catch (cause) {
    const current = changedPreview(cause);
    if (!current) throw cause;
    return attempt(current);
  }
}

/** Dopo quanto la password copiata lascia gli appunti (design «Mostrare e copiare»). */
export const CLIPBOARD_CLEAR_MS = 30_000;

/**
 * Copia negli appunti e, dopo {@link CLIPBOARD_CLEAR_MS}, li svuota — solo
 * se contengono ancora la password copiata, per non cancellare ciò che la
 * persona ha copiato nel frattempo. Se il browser non lascia rileggere gli
 * appunti (permesso negato, Firefox) li svuota comunque: non poter
 * verificare non è un motivo per lasciarci la password. Il timer NON si
 * annulla smontando il componente: la password copiata resta negli appunti
 * anche se si cambia pagina.
 */
export async function copyWithAutoClear(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  await clipboard.writeText(value);
  setTimeout(() => {
    void (async () => {
      let current: string | null = null;
      try {
        current = await clipboard.readText();
      } catch {
        current = null;
      }
      if (current === null || current === value) {
        try {
          await clipboard.writeText("");
        } catch {
          // Scheda senza fuoco o permesso revocato: non c'è altro da fare.
        }
      }
    })();
  }, CLIPBOARD_CLEAR_MS);
}

/**
 * Le copie per confermare un accesso in attesa (design «Lettori che arrivano
 * dopo, e la conferma»): apre ogni copia data con `openerKey` — la propria
 * chiave privata (`openerId` = il proprio `personKeyId`) o quella del kit di
 * recupero (`openerId` = `"recovery"`) — e ricifra la chiave d'oggetto per la
 * pubblica della persona. Una copia che non si apre si salta (`failed`): le
 * altre passano lo stesso, e quella resta in attesa di un altro lettore.
 */
export async function rewrapForPerson(
  credentials: readonly { id: string; wrappedKey: string; keyVersion: string }[],
  opener: { privateKey: CryptoKey; recipientId: string },
  person: { personKeyId: string; publicKey: string },
): Promise<{ copies: { credentialId: string; wrappedKey: string; keyVersion: string }[]; failed: string[] }> {
  const copies: { credentialId: string; wrappedKey: string; keyVersion: string }[] = [];
  const failed: string[] = [];
  for (const credential of credentials) {
    try {
      const itemKey = await unwrapItemKey(credential.wrappedKey, opener.privateKey, credential.id, opener.recipientId);
      copies.push({
        credentialId: credential.id,
        wrappedKey: await wrapItemKey(itemKey, person.publicKey, credential.id, person.personKeyId),
        keyVersion: credential.keyVersion,
      });
    } catch {
      failed.push(credential.id);
    }
  }
  return { copies, failed };
}

/**
 * Le copie per la rotazione del kit di recupero (Impostazioni → Cassaforte,
 * full admin): la chiave di OGNI credenziale dell'anteprima — aperta con la
 * propria privata — ricifrata per la pubblica del kit NUOVO (destinatario
 * `recovery`). Lancia, e nulla parte, se l'anteprima ha credenziali senza la
 * propria copia (la rotazione le vuole tutte: la pagina lo dice prima), se è
 * per un'altra chiave o se una copia non si apre.
 */
export async function recoveryKitCopies(
  preview: VaultRecoveryKeyPreview,
  key: OpenKey,
  recoveryPublicKey: string,
): Promise<{ credentialId: string; wrappedKey: string }[]> {
  if ((preview.missing ?? []).length > 0) throw new Error("rotazione del kit: mancano copie");
  if (preview.personKeyId !== key.personKeyId) throw new VaultError("stale_key");
  const copies: { credentialId: string; wrappedKey: string }[] = [];
  for (const credential of preview.credentials ?? []) {
    let itemKey: CryptoKey;
    try {
      itemKey = await unwrapItemKey(credential.wrappedKey, key.privateKey, credential.id, key.personKeyId);
    } catch {
      throw new VaultError("open_failed");
    }
    copies.push({
      credentialId: credential.id,
      wrappedKey: await wrapItemKey(itemKey, recoveryPublicKey, credential.id, "recovery"),
    });
  }
  return copies;
}
