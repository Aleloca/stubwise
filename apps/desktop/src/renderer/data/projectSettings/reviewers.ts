import type { GitAccount } from "../instance/state";

// Chi può rivedere le PR di un repository (la regola del web), puro:
// `repositories.ts` lo ri-esporta e lo applica in `updateRepository`.

/** Perché un account non può rivedere le PR scritte da `main`, o `null` se può. */
export type ReviewUnavailable = "main" | "other_platform" | null;
export const reviewUnavailable = (
  main: Pick<GitAccount, "id" | "provider"> | undefined,
  review: Pick<GitAccount, "id" | "provider">,
): ReviewUnavailable =>
  main && review.id === main.id
    ? "main"
    : !main || review.provider !== main.provider
      ? "other_platform"
      : null;

/**
 * Le scelte del menu «Review account» per l'account principale `mainId`
 * (regola del web): della stessa piattaforma e diverso dal principale; gli
 * altri restano nell'elenco con la ragione. `defaultReviewer` è il revisore
 * predefinito dello stesso ambito (piattaforma e workspace) che rivede
 * quando il repository non ne sceglie uno, o `null` (mai il principale
 * stesso). Pura, sugli account che la pagina ha già letto: la stessa regola
 * che `updateRepository` applica (Task 8).
 */
export function reviewAccountChoices(
  accounts: readonly Pick<GitAccount, "id" | "name" | "provider" | "workspace" | "defaultReviewer">[],
  mainId: string | null,
): {
  defaultReviewer: { id: string; name: string } | null;
  choices: { id: string; name: string; unavailable: ReviewUnavailable }[];
} {
  const main = accounts.find((a) => a.id === mainId);
  const scope = (a: Pick<GitAccount, "provider" | "workspace">) =>
    `${a.provider}|${(a.workspace ?? "").toLowerCase()}`;
  const reviewer = main
    ? accounts.find((a) => a.defaultReviewer && a.id !== main.id && scope(a) === scope(main))
    : undefined;
  return {
    defaultReviewer: reviewer ? { id: reviewer.id, name: reviewer.name } : null,
    choices: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      unavailable: reviewUnavailable(main, a),
    })),
  };
}
