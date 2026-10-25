import type { Repository } from "../../types";

// I repository collegati, il minimo per i Docs (uno spazio per repository):
// STW e AUD coi nomi di `repoFiles.ts` e `commits.ts`; CBV, progetto cliente
// col modulo Docs, ha un repository con le sole pagine scritte a mano.
// Gli altri progetti `software` non hanno un repository nel seme: i loro Docs
// sono vuoti.

export const REPOSITORIES: Repository[] = [
  { id: "repo-stw", projectId: "prj-stw", name: "stubwise" },
  { id: "repo-aud", projectId: "prj-aud", name: "audin-app" },
  { id: "repo-cbv", projectId: "prj-cbv", name: "bellavista-store" },
];
