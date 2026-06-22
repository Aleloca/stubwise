import { describe, it, expect } from "vitest";
import {
  parseDotenv,
  serializeDotenv,
  isValidEnvKey,
  isSafeRelPath,
} from "./dotenv.js";

describe("parseDotenv", () => {
  it("parsa KEY=value semplice", () => {
    expect(parseDotenv("KEY=value")).toEqual([{ key: "KEY", value: "value" }]);
  });

  it("trimma gli spazi attorno a key e al valore non quotato", () => {
    expect(parseDotenv("  KEY = value  ")).toEqual([{ key: "KEY", value: "value" }]);
  });

  it("ignora righe vuote e commenti", () => {
    const text = ["# commento iniziale", "", "   ", "KEY=value", "# altro commento"].join("\n");
    expect(parseDotenv(text)).toEqual([{ key: "KEY", value: "value" }]);
  });

  it("supporta il prefisso export", () => {
    expect(parseDotenv("export KEY=value")).toEqual([{ key: "KEY", value: "value" }]);
  });

  it("rimuove gli apici doppi mantenendo gli spazi interni", () => {
    expect(parseDotenv('KEY="a b"')).toEqual([{ key: "KEY", value: "a b" }]);
  });

  it("espande \\n in newline dentro apici doppi", () => {
    expect(parseDotenv('KEY="riga1\\nriga2"')).toEqual([
      { key: "KEY", value: "riga1\nriga2" },
    ]);
  });

  it("gestisce l'escape \\\" dentro apici doppi", () => {
    expect(parseDotenv('KEY="a \\" b"')).toEqual([{ key: "KEY", value: 'a " b' }]);
  });

  it("non espande escape dentro apici singoli (letterale)", () => {
    expect(parseDotenv("KEY='a b'")).toEqual([{ key: "KEY", value: "a b" }]);
    expect(parseDotenv("KEY='riga1\\nriga2'")).toEqual([
      { key: "KEY", value: "riga1\\nriga2" },
    ]);
  });

  it("conserva = dentro un valore non quotato", () => {
    expect(parseDotenv("URL=postgres://u:p@h/db?x=1")).toEqual([
      { key: "URL", value: "postgres://u:p@h/db?x=1" },
    ]);
  });

  it("conserva # dentro un valore quotato", () => {
    expect(parseDotenv('KEY="a # b"')).toEqual([{ key: "KEY", value: "a # b" }]);
  });

  it("taglia il commento inline su valore non quotato quando # è preceduto da spazio", () => {
    expect(parseDotenv("KEY=value # commento")).toEqual([
      { key: "KEY", value: "value" },
    ]);
  });

  it("non taglia # attaccato al valore non quotato (non preceduto da spazio)", () => {
    expect(parseDotenv("KEY=value#nocomment")).toEqual([
      { key: "KEY", value: "value#nocomment" },
    ]);
  });

  it("gestisce valore vuoto", () => {
    expect(parseDotenv("KEY=")).toEqual([{ key: "KEY", value: "" }]);
  });

  it("scarta chiavi non valide e righe senza =", () => {
    const text = ["123=x", "MIA-CHIAVE=x", "righa senza uguale", "OK=1"].join("\n");
    expect(parseDotenv(text)).toEqual([{ key: "OK", value: "1" }]);
  });

  it("gestisce valore multiline tra apici doppi su righe fisiche distinte", () => {
    const text = 'KEY="riga1\nriga2"';
    expect(parseDotenv(text)).toEqual([{ key: "KEY", value: "riga1\nriga2" }]);
  });

  it("non lancia su input malformato, scarta e continua", () => {
    const text = ["= solo uguale", "BAD KEY=1", "GOOD=2"].join("\n");
    expect(() => parseDotenv(text)).not.toThrow();
    expect(parseDotenv(text)).toEqual([{ key: "GOOD", value: "2" }]);
  });

  it("scarta la riga con apice doppio non chiuso senza lanciare", () => {
    const text = ['KEY="non chiuso', "OK=1"].join("\n");
    expect(() => parseDotenv(text)).not.toThrow();
    expect(parseDotenv(text)).toEqual([{ key: "OK", value: "1" }]);
  });

  it("parsa più variabili", () => {
    const text = ["A=1", "B=2", "C=3"].join("\n");
    expect(parseDotenv(text)).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
      { key: "C", value: "3" },
    ]);
  });
});

describe("serializeDotenv", () => {
  it("scrive KEY=value nudo per valori semplici", () => {
    expect(serializeDotenv([{ key: "KEY", value: "value" }])).toBe("KEY=value");
  });

  it("quota con apici doppi i valori con spazi", () => {
    expect(serializeDotenv([{ key: "KEY", value: "a b" }])).toBe('KEY="a b"');
  });

  it("quota ed escapa newline come \\n", () => {
    expect(serializeDotenv([{ key: "KEY", value: "a\nb" }])).toBe('KEY="a\\nb"');
  });

  it("quota ed escapa apici doppi e backslash", () => {
    expect(serializeDotenv([{ key: "KEY", value: 'a"b\\c' }])).toBe('KEY="a\\"b\\\\c"');
  });

  it("quota i valori che contengono #", () => {
    expect(serializeDotenv([{ key: "KEY", value: "a#b" }])).toBe('KEY="a#b"');
  });

  it("scrive valore vuoto come KEY=", () => {
    expect(serializeDotenv([{ key: "KEY", value: "" }])).toBe("KEY=");
  });

  it("unisce più variabili con newline", () => {
    expect(
      serializeDotenv([
        { key: "A", value: "1" },
        { key: "B", value: "2" },
      ]),
    ).toBe("A=1\nB=2");
  });
});

describe("round-trip parse(serialize(vars))", () => {
  it("preserva valori con spazi, newline, apici doppi, #, = e backslash", () => {
    const vars = [
      { key: "PLAIN", value: "simple" },
      { key: "EMPTY", value: "" },
      { key: "SPACES", value: "a b c" },
      { key: "NEWLINE", value: "riga1\nriga2" },
      { key: "QUOTE", value: 'ha "virgolette"' },
      { key: "HASH", value: "valore # con cancelletto" },
      { key: "EQ", value: "postgres://u:p@h/db?x=1&y=2" },
      { key: "BACKSLASH", value: "c:\\path\\to" },
      { key: "LEADING_EQ", value: "=startswithequal" },
      { key: "MIXED", value: 'tab\tend\n"q" #h = e' },
    ];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });

  it("preserva un valore fatto di soli spazi", () => {
    const vars = [{ key: "SPACES_ONLY", value: "   " }];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });

  it("preserva un valore che inizia e finisce con apice doppio", () => {
    const vars = [{ key: "WRAPPED", value: '"interno"' }];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });

  it("distingue \\n LETTERALE (backslash+n) da un newline reale", () => {
    const vars = [
      { key: "LITERAL", value: "riga1\\nriga2" }, // backslash + n, NON newline
      { key: "REAL", value: "riga1\nriga2" }, // newline reale
    ];
    const roundTripped = parseDotenv(serializeDotenv(vars));
    expect(roundTripped).toEqual(vars);
    // Blindatura esplicita: il letterale non contiene un newline reale.
    expect(roundTripped[0]?.value).not.toContain("\n");
    expect(roundTripped[1]?.value).toContain("\n");
  });

  it("preserva un valore multiline su 3+ righe fisiche", () => {
    const vars = [{ key: "MULTI", value: "uno\ndue\ntre\nquattro" }];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });

  it("preserva un valore con backslash finale", () => {
    const vars = [{ key: "TRAILING_BS", value: "path\\" }];
    expect(parseDotenv(serializeDotenv(vars))).toEqual(vars);
  });
});

describe("isValidEnvKey", () => {
  it("accetta chiavi valide", () => {
    for (const k of ["KEY", "_KEY", "a", "DATABASE_URL", "X1", "_1"]) {
      expect(isValidEnvKey(k)).toBe(true);
    }
  });
  it("rifiuta chiavi non valide", () => {
    for (const k of ["1KEY", "MIA-CHIAVE", "KEY KEY", "", "KEY!", "à"]) {
      expect(isValidEnvKey(k)).toBe(false);
    }
  });
});

describe("isSafeRelPath", () => {
  it("accetta path relativi dentro l'albero", () => {
    for (const p of [".env", ".env.local", "apps/web/.env", "a/b/c.txt"]) {
      expect(isSafeRelPath(p)).toBe(true);
    }
  });
  it("rifiuta path assoluti, traversal e vuoti", () => {
    for (const p of ["/etc/passwd", "../x", "a/../../b", "", "C:\\Windows", "a/../b", "./x"]) {
      expect(isSafeRelPath(p)).toBe(false);
    }
  });
  it("rifiuta segmenti vuoti o whitespace-only", () => {
    for (const p of [" ", "  ", "\t", "a/ /b", "a//b", "a/b/"]) {
      expect(isSafeRelPath(p)).toBe(false);
    }
  });
  it("accetta `...`/`....` come nomi file POSIX validi", () => {
    for (const p of ["...", "....", "a/.../b"]) {
      expect(isSafeRelPath(p)).toBe(true);
    }
  });
  it("accetta nomi dotenv comuni", () => {
    for (const p of [".env.local", "apps/web/.env"]) {
      expect(isSafeRelPath(p)).toBe(true);
    }
  });
});
