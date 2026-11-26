import { describe, expect, it } from "vitest";
import { withHiddenBlocks } from "./home";

// I blocchi che questa app non mostra (un tipo che non conosce, un'area non
// ancora integrata) non si perdono salvando la Home: tornano al loro posto
// relativo, o in coda. Si tolgono solo con «Ripristina».

type B = { kind: string; filterId?: string };
const k = (...kinds: string[]): B[] => kinds.map((kind) => ({ kind }));
const hidden = (b: B) => b.kind === "importantMail" || b.kind === "__future__";

describe("withHiddenBlocks", () => {
  it("un nascosto torna dopo il visibile che lo precedeva", () => {
    const original = k("decide", "myWeek", "importantMail", "myTasks", "__future__", "stalledInMyProjects");
    const edited = k("decide", "myWeek", "stalledInMyProjects", "myTasks");
    expect(withHiddenBlocks(edited, original, hidden).map((b) => b.kind)).toEqual([
      "decide",
      "myWeek",
      "importantMail",
      "stalledInMyProjects",
      "myTasks",
      "__future__",
    ]);
  });

  it("se il visibile che lo precedeva è stato tolto, si ancora a quello prima; in testa resta in testa", () => {
    const original = k("__future__", "decide", "myWeek", "myTasks", "importantMail");
    const edited = k("decide", "myWeek");
    expect(withHiddenBlocks(edited, original, hidden).map((b) => b.kind)).toEqual([
      "__future__",
      "decide",
      "myWeek",
      "importantMail",
    ]);
  });

  it("senza alcun visibile prima di lui ancora presente, va in coda", () => {
    const original = k("myTasks", "importantMail", "decide", "myWeek");
    const edited = k("decide", "myWeek");
    expect(withHiddenBlocks(edited, original, hidden).map((b) => b.kind)).toEqual([
      "decide",
      "myWeek",
      "importantMail",
    ]);
  });

  it("niente doppi, e i filtri si distinguono per filtro", () => {
    const original: B[] = [{ kind: "decide" }, { kind: "importantMail" }, { kind: "filter", filterId: "a" }];
    const edited: B[] = [{ kind: "decide" }, { kind: "importantMail" }, { kind: "filter", filterId: "b" }];
    expect(withHiddenBlocks(edited, original, hidden)).toEqual(edited);
  });
});
