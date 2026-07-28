import { createHash } from "node:crypto";

/**
 * Slug stabile e filesystem-safe per la directory del mirror: parte
 * leggibile (URL sanitizzato) + suffisso sha256 dell'URL originale. Il
 * suffisso garantisce l'assenza di collisioni anche quando la sanitizzazione
 * appiattirebbe URL diversi sulla stessa stringa (es. `my_repo` vs `my-repo`,
 * o trattini che si confondono con i separatori host/owner/repo).
 *
 * Vive in `shared` perché i mirror bare hanno DUE lettori: il worker, che li
 * clona e ci lavora (`apps/worker/src/git/mirrors.ts` la ri-esporta), e il
 * server, che monta lo stesso volume in read-only per leggere gli snippet di
 * codice citati nelle chat.
 *
 * Sta FUORI dal barrel `index.ts` (si importa da `@stubwise/shared/mirror-slug`)
 * perché `node:crypto` non esiste nel browser e apps/web importa il barrel:
 * metterlo lì rompe il build vite della SPA anche se la funzione non è usata.
 */
export function mirrorSlug(repoUrl: string): string {
  const hash = createHash("sha256").update(repoUrl).digest("hex").slice(0, 12);
  const readable = repoUrl
    .replace(/^[a-z+.-]+:\/\//i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase()
    .slice(0, 100);
  return readable.length > 0 ? `${readable}-${hash}` : hash;
}
