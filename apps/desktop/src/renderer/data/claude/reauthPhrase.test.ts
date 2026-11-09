import { beforeEach, describe, expect, it } from "vitest";
import { visiblePeopleFor } from "../access/whoCan";
import { resetApi, setLatency } from "../api";
import { PEOPLE } from "../seed/people";
import { reauthPhraseOf } from "./reauthPhrase";

// La frase della riconferma di una scheda C (M1 della revisione finale):
// all'infinito, coi nomi che chi chiede vede; mai il nome di chi non vede.

const ROBERTA = "p-roberta";
const MARCO = "p-marco";
const LAURA = "p-laura";
const OLV = "prj-olv";

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("reauthPhraseOf", () => {
  it("addMember: nome, codice e ruolo come parametri della chiave all'infinito", () => {
    expect(
      reauthPhraseOf(ROBERTA, {
        fn: "addMember",
        args: { projectId: OLV, personId: LAURA, roleId: "role-developer" },
      }),
    ).toEqual({
      key: "claude.conversation.proposal.reauthAction.addMember",
      params: { name: "Laura Costa", code: "OLV", role: "Developer" },
    });
  });

  it("una persona che chi chiede non vede: nessuna frase (la pagina usa quella generica)", () => {
    const hidden = PEOPLE.find((p) => !p.isClaude && !visiblePeopleFor(MARCO).has(p.id))!;
    expect(
      reauthPhraseOf(MARCO, {
        fn: "removeMember",
        args: { projectId: OLV, personId: hidden.id },
      }),
    ).toBeNull();
  });

  it("un'azione che non è C non ha frase", () => {
    expect(reauthPhraseOf(ROBERTA, { fn: "createTask", args: {} })).toBeNull();
  });
});
