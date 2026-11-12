/**
 * L'id di una conversazione nell'app: l'uuid della casella + `_` + l'id
 * Gmail del thread (passa per l'indirizzo, `/mail/<id>`, che ammette
 * lettere, cifre, `-` e `_`). L'id Gmail da solo non basta: lo stesso thread
 * su due caselle mie sono due conversazioni (e il server vuole `account`).
 */
const UUID_LENGTH = 36;
export const threadKey = (accountId: string, gmailThreadId: string) => `${accountId}_${gmailThreadId}`;
export function splitThreadKey(key: string): { accountId: string; threadId: string } | null {
  if (key.length <= UUID_LENGTH + 1 || key[UUID_LENGTH] !== "_") return null;
  return { accountId: key.slice(0, UUID_LENGTH), threadId: key.slice(UUID_LENGTH + 1) };
}
