import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessageHit } from "../../data/types";
import { clearChatColumnPrefs, recentSearchesOf, rememberSearch } from "./column";
import {
  filtersOf,
  forgetResults,
  groupByChannel,
  hasFilters,
  highlightParts,
  isSearchParamValue,
  plainText,
  rememberResults,
  resultsFor,
  searchWords,
} from "./search";

beforeEach(() => {
  clearChatColumnPrefs();
  forgetResults();
});

const marked = (text: string, q: string) =>
  highlightParts(text, searchWords(q))
    .filter((p) => p.hit)
    .map((p) => p.text);

describe("ricerca della Chat: evidenza", () => {
  it("evidenzia le parole senza maiuscole né accenti, sul testo originale", () => {
    expect(marked("The new Price List is in", "price list")).toEqual(["Price", "List"]);
    expect(marked("Il caffè è pronto", "CAFFE")).toEqual(["caffè"]);
    expect(marked("Il caffè è pronto", "caffè")).toEqual(["caffè"]);
    expect(marked("price, price list", "price")).toEqual(["price", "price"]);
    expect(highlightParts("niente", searchWords("zz"))).toEqual([{ text: "niente", hit: false }]);
    // I pezzi ricompongono il testo.
    const text = "Città: la prossima città";
    expect(
      highlightParts(text, searchWords("citta"))
        .map((p) => p.text)
        .join(""),
    ).toBe(text);
  });

  it("il testo di un messaggio senza markdown", () => {
    expect(plainText("## Title\n- **one** item\n> quoted [link](http://x)")).toBe(
      "Title one item quoted link",
    );
  });
});

describe("ricerca della Chat: parametri e filtri", () => {
  it("dai parametri dell'indirizzo ai filtri di searchChat", () => {
    expect(filtersOf({ q: "x" })).toEqual({});
    expect(
      filtersOf({ q: "x", in: "ch-1", by: "p-marco", att: "1", cit: "1", ppl: "1", when: "7d" }),
    ).toEqual({
      channelId: "ch-1",
      authorId: "p-marco",
      withAttachments: true,
      withCitations: true,
      peopleOnly: true,
      from: "2026-10-17",
      to: "2026-10-23",
    });
    expect(filtersOf({ when: "today" })).toMatchObject({ from: "2026-10-23", to: "2026-10-23" });
    expect(filtersOf({ when: "custom", since: "2026-09-01" })).toEqual({ from: "2026-09-01" });
    expect(hasFilters({ q: "x" })).toBe(false);
    expect(hasFilters({ q: "x", cit: "1" })).toBe(true);
  });

  it("valida la forma dei parametri", () => {
    expect(isSearchParamValue("q", "price list")).toBe(true);
    expect(isSearchParamValue("q", "")).toBe(false);
    expect(isSearchParamValue("when", "7d")).toBe(true);
    expect(isSearchParamValue("when", "ever")).toBe(false);
    expect(isSearchParamValue("since", "2026-10-01")).toBe(true);
    expect(isSearchParamValue("att", "yes")).toBe(false);
    expect(isSearchParamValue("in", "ch aud")).toBe(false);
  });

  it("raggruppa per canale nell'ordine della corrispondenza più recente", () => {
    const hit = (id: string, channelId: string) =>
      ({ channelId, message: { id }, context: null }) as unknown as ChatMessageHit;
    const groups = groupByChannel([hit("a", "c2"), hit("b", "c1"), hit("c", "c2")]);
    expect(groups.map((g) => [g.channelId, g.hits.map((h) => h.message.id)])).toEqual([
      ["c2", ["a", "c"]],
      ["c1", ["b"]],
    ]);
  });
});

describe("ricerca della Chat: ciò che si ricorda", () => {
  it("le ultime 5 ricerche, di una persona sola: un'altra persona le trova vuote e le cancella", () => {
    for (const q of ["one", "two", "three", "four", "five", "six", "Two"]) {
      rememberSearch("p-giulia", q);
    }
    expect(recentSearchesOf("p-giulia")).toEqual(["Two", "six", "five", "four", "three"]);
    rememberSearch("p-giulia", "x");
    expect(recentSearchesOf("p-giulia")).toHaveLength(5);
    expect(recentSearchesOf("p-marco")).toEqual([]);
    expect(recentSearchesOf("p-giulia")).toEqual([]);
  });

  it("il ritorno ai risultati vale per la persona e il messaggio raggiunti", () => {
    rememberResults({
      personId: "p-giulia",
      messageId: "m1",
      href: "/chat?view=search&q=x",
      selected: "m1",
    });
    expect(resultsFor("p-giulia", "m1")?.href).toBe("/chat?view=search&q=x");
    expect(resultsFor("p-giulia", "m2")).toBeNull();
    expect(resultsFor("p-marco", "m1")).toBeNull();
    expect(resultsFor("p-giulia", undefined)).toBeNull();
  });
});
