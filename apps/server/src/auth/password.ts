import argon2 from "argon2";

/**
 * Hash della password con argon2id (raccomandazione OWASP: resiste sia agli
 * attacchi GPU sia ai side-channel). I parametri di default della libreria
 * (m=64MiB, t=3, p=4) sono già allineati alle linee guida correnti.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

/** Verifica una password contro l'hash salvato. Non lancia su hash malformati. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
