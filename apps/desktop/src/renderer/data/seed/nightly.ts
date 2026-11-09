import type { NightlyRow } from "../instance/state";
import { TODAY } from "./dates";

// Il giro notturno della notte scorsa (area 9b, Task 5): quattro righe, solo
// da guardare nello Stato dell'istanza. Il prototipo non lo esegue: riassunti
// dei commit, nota di rilascio e Docs si leggono come sono finiti. Una riga è
// fallita; una aspetta la notte dopo (il giro riprende da dove si è fermato).

const at = (hm: string): string => `${TODAY}T${hm}:00Z`;

export const NIGHTLY_ROWS: readonly NightlyRow[] = [
  {
    id: "nl-stw-commits",
    projectId: "prj-stw",
    repositoryName: "stubwise",
    phase: "commit_summary",
    state: "done",
    at: at("02:04"),
    summary: null,
  },
  {
    id: "nl-stw-docs",
    projectId: "prj-stw",
    repositoryName: "stubwise",
    phase: "docs",
    state: "done",
    at: at("02:31"),
    summary: null,
  },
  {
    id: "nl-aud-release-note",
    projectId: "prj-aud",
    repositoryName: "audin-app",
    phase: "release_note",
    state: "failed",
    at: at("02:18"),
    summary:
      "The release note couldn't be written: the tag v2.4.0 points to a commit that isn't on main.",
  },
  {
    id: "nl-cbv-docs",
    projectId: "prj-cbv",
    repositoryName: "bellavista-store",
    phase: "docs",
    state: "waiting",
    at: at("02:47"),
    summary: "Stopped at the account quota: it picks up tonight where it stopped.",
  },
];
