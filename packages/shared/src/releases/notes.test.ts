import { describe, expect, it } from "vitest";
import { citedTaskCodes, releaseNotesDraft } from "./notes.js";

// Area 8, F1: la bozza delle note di una PR, pura (era `data/releases/notes.ts`
// del prototipo): il chiamante passa le task già filtrate.

describe("citedTaskCodes", () => {
  it("la task della PR, poi i codici citati dai commit, senza doppioni; mai i codici delle richieste", () => {
    expect(
      citedTaskCodes("ACQ-12", [
        "ACQ-12 primo",
        "fix ACQ-14 e ACQ-15",
        "ACQ-R3 una richiesta",
        "niente",
      ]),
    ).toEqual(["ACQ-12", "ACQ-14", "ACQ-15"]);
    expect(citedTaskCodes(null, [])).toEqual([]);
  });
});

describe("releaseNotesDraft", () => {
  it("una riga per task trovata, nell'ordine; un codice senza task non dà righe", () => {
    const draft = releaseNotesDraft({
      ownTaskCode: "ACQ-12",
      commitMessages: ["ACQ-14 fix", "ACQ-99 di un altro progetto", "ACQ-14 ancora"],
      tasks: [
        { code: "ACQ-14", title: "Il secondo" },
        { code: "ACQ-12", title: "Il primo" },
      ],
    });
    expect(draft).toEqual({
      text: "- ACQ-12: Il primo\n- ACQ-14: Il secondo",
      sources: ["ACQ-12", "ACQ-14"],
    });
  });
  it("nessuna task trovata: testo vuoto, nessuna fonte", () => {
    expect(releaseNotesDraft({ ownTaskCode: null, commitMessages: ["chore"], tasks: [] })).toEqual({
      text: "",
      sources: [],
    });
  });
});
