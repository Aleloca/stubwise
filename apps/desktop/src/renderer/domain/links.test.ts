import { describe, expect, it } from "vitest";
import { makeTask } from "./fixtures";
import { blockerIdsOf, linksOf, withoutLink } from "./links";

const a = makeTask({ id: "a", links: [{ kind: "blocks", taskId: "b" }] });
const b = makeTask({ id: "b", links: [{ kind: "parent", taskId: "c" }] });
const c = makeTask({ id: "c", links: [{ kind: "relates", taskId: "a" }] });
const all = [a, b, c];

describe("linksOf", () => {
  it("le righe proprie più gli inversi ricavati, ognuno con la task che tiene la riga", () => {
    expect(linksOf(a, all)).toEqual([
      { kind: "blocks", taskId: "b", holderId: "a", row: { kind: "blocks", taskId: "b" } },
      { kind: "relates", taskId: "c", holderId: "c", row: { kind: "relates", taskId: "a" } },
    ]);
    expect(linksOf(b, all)).toEqual([
      { kind: "parent", taskId: "c", holderId: "b", row: { kind: "parent", taskId: "c" } },
      { kind: "blocked_by", taskId: "a", holderId: "a", row: { kind: "blocks", taskId: "b" } },
    ]);
    expect(linksOf(c, all).map((l) => [l.kind, l.taskId])).toEqual([
      ["relates", "a"],
      ["child", "b"],
    ]);
  });

  it("un inverso da una task che non si vede (non nell'elenco) non c'è", () => {
    expect(linksOf(b, [b, c])).toEqual([
      { kind: "parent", taskId: "c", holderId: "b", row: { kind: "parent", taskId: "c" } },
    ]);
  });

  it("blockerIdsOf: chi tiene una riga «blocks» verso la task", () => {
    expect(blockerIdsOf("b", all)).toEqual(["a"]);
    expect(blockerIdsOf("a", all)).toEqual([]);
  });

  it("withoutLink toglie la riga dalla task che la tiene", () => {
    expect(withoutLink(a, { kind: "blocks", taskId: "b" })).toEqual([]);
    expect(withoutLink(a, { kind: "relates", taskId: "b" })).toEqual(a.links);
  });
});
