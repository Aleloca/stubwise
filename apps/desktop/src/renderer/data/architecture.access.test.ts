import { describe, expect, it } from "vitest";

// Ogni appartenenza nuova data da qualcuno passa da UN posto (area 9a, C1
// della revisione finale): `judgeJoin` la giudica (escalation su ruolo e
// reparto, riconferma del chiamante) e `writeJoin` la scrive con la sua voce
// `member.added`, in `data/admin/members.ts`. `grantProjectRole` di
// `viewer.ts` resta la scorciatoia dei test delle aree 2–8: fuori dai test
// non la chiama nessuno. L'altra strada ammessa è l'accettazione di un
// invito (`auth/register.ts`), giudicato quando è stato creato.

const SOURCES = import.meta.glob(["../**/*.{ts,tsx}", "!**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const norm = (path: string): string =>
  path.startsWith("./") ? `data/${path.slice(2)}` : path.replace(/^\.\.\//, "");
const FILES = new Map(Object.entries(SOURCES).map(([p, s]) => [norm(p), s]));

const filesMatching = (re: RegExp): string[] =>
  [...FILES].filter(([, source]) => re.test(source)).map(([path]) => path).sort();

describe("un solo scrittore delle appartenenze", () => {
  it("trova i sorgenti", () => {
    expect(FILES.size).toBeGreaterThan(100);
    expect(FILES.has("data/admin/members.ts")).toBe(true);
  });

  it("grantProjectRole si chiama solo nei test", () => {
    // La definizione sta in viewer.ts; nessun altro sorgente la chiama.
    expect(filesMatching(/grantProjectRole\s*\(/)).toEqual(["data/viewer.ts"]);
    expect(FILES.get("data/viewer.ts")!.match(/grantProjectRole\s*\(/g)).toHaveLength(1);
  });

  it("le appartenenze si aggiungono solo da writeJoin, dall'invito accettato e dalla scorciatoia dei test", () => {
    expect(filesMatching(/memberships\.push\(/)).toEqual([
      "data/admin/members.ts",
      "data/auth/register.ts",
      "data/viewer.ts",
    ]);
  });
});
