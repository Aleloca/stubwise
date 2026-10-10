import type { TranscriptItem } from "@stubwise/shared";
import { collapsedHead, liveTail, sameTranscriptItem } from "./transcript-text";

describe("liveTail", () => {
  test("un testo corto resta intero", () => {
    expect(liveTail("ciao", 10)).toEqual({ text: "ciao", cut: false });
  });

  test("di un testo lungo tiene la coda", () => {
    expect(liveTail("0123456789abc", 4)).toEqual({ text: "9abc", cut: true });
  });

  test("non spezza un'emoji al taglio", () => {
    const text = `ab😀cd`; // 😀 = due unità UTF-16, agli indici 2 e 3
    const { text: tail } = liveTail(text, 3);
    expect(tail).toBe("cd");
    expect(tail.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  });
});

describe("collapsedHead", () => {
  test("un testo entro il limite resta intero", () => {
    expect(collapsedHead("riga", 10)).toBe("riga");
  });

  test("taglia all'ultimo a capo nella seconda metà", () => {
    expect(collapsedHead("aaaa\nbbbb\ncccc", 12)).toBe("aaaa\nbbbb");
  });

  test("senza un a capo utile taglia al limite", () => {
    expect(collapsedHead("a\nbbbbbbbbbbbbbbb", 10)).toBe("a\nbbbbbbbb");
  });
});

describe("sameTranscriptItem", () => {
  const text = (over: Partial<Extract<TranscriptItem, { kind: "text" }>> = {}): TranscriptItem => ({
    kind: "text",
    id: "1",
    text: "ciao",
    at: "2026-10-10T10:00:00Z",
    live: false,
    ...over,
  });

  test("oggetti nuovi con gli stessi campi sono uguali", () => {
    expect(sameTranscriptItem(text(), text())).toBe(true);
  });

  test("un testo cambiato no", () => {
    expect(sameTranscriptItem(text(), text({ text: "ciao!" }))).toBe(false);
  });

  test("il risultato di un tool si confronta campo per campo", () => {
    const input = { file_path: "a.ts" };
    const tool = (content: string): TranscriptItem => ({
      kind: "tool",
      id: "2",
      name: "Read",
      input,
      result: { isError: false, content, truncated: false },
      at: "2026-10-10T10:00:00Z",
    });
    expect(sameTranscriptItem(tool("x"), tool("x"))).toBe(true);
    expect(sameTranscriptItem(tool("x"), tool("y"))).toBe(false);
  });

  test("un tool che riceve il risultato cambia", () => {
    const base = { kind: "tool", id: "2", name: "Read", input: {}, at: "2026-10-10T10:00:00Z" } as const;
    expect(
      sameTranscriptItem(
        { ...base, result: null },
        { ...base, result: { isError: false, content: "x", truncated: false } },
      ),
    ).toBe(false);
  });
});
