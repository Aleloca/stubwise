import { z } from "zod";

/**
 * BRANCH PROTETTI di una repository (7 ott 2026, decisione del maintainer
 * sull'adozione delle PR aperte da altri): branch condivisi — `develop`,
 * `staging`, `release/*` — su cui Stubwise non deve MAI pushare, nemmeno
 * dopo un'adozione. Li configura un admin nel form della repository.
 *
 * UNA regola, qui: la usano il rifiuto dell'adozione (server, 422
 * `protected_branch`), il motivo del bottone spento (`loadPrAdoption`) e il
 * worker prima del worktree e prima del push (fail-closed: un branch
 * diventato protetto dopo l'adozione ferma la correzione senza push).
 *
 * Forma di una voce: un nome esatto, oppure un `*` FINALE che vale come
 * prefisso (`release/*`, `hotfix*`). Nient'altro: niente glob in mezzo,
 * niente regex — una voce che si legge come la si scrive.
 */

/** Tetto delle voci e della lunghezza di una voce. */
export const PROTECTED_BRANCHES_MAX = 50;
export const PROTECTED_BRANCH_MAX_LENGTH = 200;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Una voce valida: segmenti come un nome di branch, `*` solo in fondo. */
export function isValidProtectedBranchPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > PROTECTED_BRANCH_MAX_LENGTH) return false;
  if (pattern.includes("..")) return false;
  const body = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  if (body.includes("*")) return false;
  if (body === "") return true; // `*` da solo: tutto protetto, una scelta esplicita.
  // Con `*` il corpo può finire con "/" (`release/*`): l'ultimo segmento vuoto è il jolly.
  const parts = body.split("/");
  const last = parts.length - 1;
  return parts.every((s, i) => SEGMENT.test(s) || (i === last && s === "" && pattern.endsWith("*") && last > 0));
}

/**
 * Il branch è protetto? Nome esatto, o prefisso per una voce col `*` finale.
 * Maiuscole distinte, come in git. Una voce malformata (mai passata dalla
 * validazione) non combacia con niente: non diventa per caso un jolly.
 */
export function isProtectedBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (!isValidProtectedBranchPattern(p)) return false;
    return p.endsWith("*") ? branch.startsWith(p.slice(0, -1)) : branch === p;
  });
}

/**
 * Input del form/rotta: trim, via le voci vuote e i doppioni, poi ogni voce
 * deve essere valida. Al più {@link PROTECTED_BRANCHES_MAX} voci (contate dopo
 * la pulizia).
 */
export const protectedBranchesInputSchema = z
  .array(z.string().max(PROTECTED_BRANCH_MAX_LENGTH * 2))
  .max(PROTECTED_BRANCHES_MAX * 4)
  .transform((items) => [...new Set(items.map((s) => s.trim()).filter((s) => s.length > 0))])
  .pipe(
    z
      .array(
        z
          .string()
          .max(PROTECTED_BRANCH_MAX_LENGTH)
          .refine(isValidProtectedBranchPattern, { message: "invalid protected branch pattern" }),
      )
      .max(PROTECTED_BRANCHES_MAX),
  );

/**
 * Una PR ADOTTATA (e non rilasciata) il cui branch è PROTETTO sulla sua
 * repository (7 ott 2026): Stubwise non può correggerla finché un admin non
 * toglie il branch dai protetti o non smette di correggerla. È la regola UNA
 * che usano `derivePrCycle` (bottone spento col motivo), `enqueueCorrection`
 * sotto il lock (rifiuto senza scrivere niente, per ogni trigger: click, giro
 * automatico, «Request changes» della piattaforma) e `startRun` (ripresa).
 * Il worker resta la difesa in profondità, con `isProtectedBranch` prima del
 * worktree e prima del push.
 */
export function isAdoptedBranchProtected(
  row: { branch: string | null; adoptedAt: Date | string | null; adoptionReleasedAt: Date | string | null },
  protectedBranches: readonly string[],
): boolean {
  const adopted = row.adoptedAt !== null && row.adoptionReleasedAt === null;
  return adopted && row.branch !== null && isProtectedBranch(row.branch, protectedBranches);
}
