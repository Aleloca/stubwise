import { eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";
import { createDb, users, type Db } from "@stubwise/db";
import { resetSecondFactor } from "../auth/second-factor/reset.js";

/**
 * RECUPERO dell'ultimo admin chiuso fuori (secondo fattore perso, nessun
 * altro che possa azzerarlo dalla web): azzera il 2FA di un utente per email.
 *
 *   pnpm --filter @stubwise/server reset:second-factor -- --email <email>
 *
 * In prod col `node` COMPILATO dentro il container (niente tsx né pnpm
 * nell'immagine, Postgres senza porte sull'host):
 *
 *   docker compose exec server node dist/scripts/reset-second-factor.js --email <email>
 *
 * Sta in `src/scripts/` e non in `scripts/` come gli altri script perché usa
 * i moduli del server (`resetSecondFactor`, che scrive anche il registro e
 * l'avviso): `tsconfig.scripts-build.json` ha `rootDir: "scripts"` e non
 * compila import da `src/`, mentre il build del server emette questo file
 * proprio in `dist/scripts/`.
 *
 * Fa la stessa cosa del reset da chi gestisce gli utenti (`DELETE
 * /api/users/:id/second-factor`): cancella app, passkey, codici di riserva e
 * tutte le sessioni della persona, lascia i token; nel registro l'attore è
 * «server script» (nessun utente), e la persona riceve l'avviso. Al login
 * successivo riconfigura il secondo fattore.
 *
 * Serve solo `DATABASE_URL`: cancella righe, non decifra nulla. Esce 1 se
 * l'email non corrisponde a nessun utente.
 */

/** L'attore del registro e dell'avviso: nessun utente, solo il testo. */
export const SCRIPT_ACTOR = { id: null, email: "server script" } as const;

/** `true` se l'utente c'era (e il suo 2FA è azzerato), `false` altrimenti. */
export async function resetSecondFactorByEmail(db: Db, email: string): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) return false;
  await resetSecondFactor(db, user, SCRIPT_ACTOR);
  return true;
}

/** `--email <email>`; `null` se manca o è vuota. */
export function parseArgs(argv: readonly string[]): { email: string } | null {
  const i = argv.indexOf("--email");
  const email = i === -1 ? undefined : argv[i + 1]?.trim();
  if (!email || email.startsWith("--")) return null;
  return { email };
}

export interface ResetLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

/** Il comando su un DB già aperto: ritorna l'exit code. */
export async function run(
  db: Db,
  argv: readonly string[],
  logger: ResetLogger = { info: console.log, error: console.error },
): Promise<number> {
  const args = parseArgs(argv);
  if (!args) {
    logger.error("[reset-second-factor] uso: reset-second-factor --email <email>");
    return 1;
  }
  if (!(await resetSecondFactorByEmail(db, args.email))) {
    logger.error(`[reset-second-factor] nessun utente con email ${args.email}`);
    return 1;
  }
  logger.info(
    `[reset-second-factor] secondo fattore di ${args.email} azzerato: sessioni chiuse, al prossimo login lo riconfigura`,
  );
  return 0;
}

/** Entry point CLI: solo env e `process.exitCode`. La logica è in `run`. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[reset-second-factor] serve DATABASE_URL");
    process.exit(1);
  }
  const handle = createDb(databaseUrl);
  try {
    process.exitCode = await run(handle.db, process.argv.slice(2));
  } finally {
    await handle.client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
