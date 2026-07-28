import { describe, it, expect } from "vitest";
import { mirrorSlug } from "./mirror-slug.js";

/**
 * ⚠️ I valori attesi qui sotto sono GOLDEN: sono stati ottenuti eseguendo
 * l'implementazione originale (`apps/worker/src/git/mirrors.ts` prima dello
 * spostamento in shared) sugli stessi URL. NON vanno "aggiornati" per far
 * passare il test: lo slug è il nome della directory dei mirror già clonati
 * su disco, quindi cambiarlo renderebbe ORFANI tutti i mirror esistenti (il
 * worker ri-clonerebbe da zero e il server non troverebbe più i blob per gli
 * snippet di codice). Un fallimento di questi test è il segnale che la
 * funzione è cambiata in modo incompatibile.
 */
describe("mirrorSlug", () => {
  it("mantiene stabile lo slug di un URL https (parte leggibile + hash)", () => {
    expect(mirrorSlug("https://bitbucket.org/acme/my-repo.git")).toBe(
      "bitbucket.org-acme-my-repo.git-ce38eb0c8d3c",
    );
  });

  it("mantiene stabile lo slug di un URL ssh", () => {
    expect(mirrorSlug("git@github.com:Acme/My_Repo.git")).toBe(
      "git-github.com-acme-my_repo.git-37f7a9f8e9a2",
    );
  });

  it("sanitizza i caratteri non filesystem-safe restando stabile", () => {
    expect(mirrorSlug("https://user:pa ss@example.com/a//b/../c.git")).toBe(
      "user-pa-ss-example.com-a-b-..-c.git-e23185782740",
    );
    expect(mirrorSlug("https://example.com/répo!.git")).toBe("example.com-r-po-.git-7fa53b4cb49c");
  });

  it("ripiega sul solo hash quando la parte leggibile si svuota", () => {
    expect(mirrorSlug("///")).toBe("732c4e971163");
  });

  it("distingue URL che la sanitizzazione appiattirebbe (`my_repo` vs `my-repo`)", () => {
    const underscore = mirrorSlug("https://bitbucket.org/acme/my_repo.git");
    const dash = mirrorSlug("https://bitbucket.org/acme/my-repo.git");
    expect(underscore).toBe("bitbucket.org-acme-my_repo.git-73cdea028834");
    expect(underscore).not.toBe(dash);
  });

  it("è deterministico (stesso URL → stesso slug)", () => {
    const url = "https://bitbucket.org/acme/my-repo.git";
    expect(mirrorSlug(url)).toBe(mirrorSlug(url));
  });
});
