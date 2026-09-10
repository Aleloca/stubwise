import { describe, expect, it } from "vitest";
import { computeReleaseRisk } from "./release-risk.js";

describe("computeReleaseRisk", () => {
  it.each([
    ["migrazione", ["packages/db/drizzle/0075_x.sql"], 1, "migrazione"],
    ["file d'ambiente", ["apps/server/.env.production"], 1, "file d'ambiente"],
    ["chiave/certificato", ["certs/server.key"], 1, "file d'ambiente"],
    ["path con 'secret'", ["apps/server/src/secrets-vault.ts"], 1, "file d'ambiente"],
    ["lockfile pnpm", ["pnpm-lock.yaml"], 1, "lockfile"],
    ["lockfile npm", ["package-lock.json"], 1, "lockfile"],
    ["CI GitHub Actions", [".github/workflows/ci.yml"], 1, "configurazione di CI/deploy"],
    ["Dockerfile", ["Dockerfile"], 1, "configurazione di CI/deploy"],
    ["docker-compose", ["docker-compose.yml"], 1, "configurazione di CI/deploy"],
  ] as const)("alto rischio: %s", (_label, changedFiles, repoCount, expectedSubstring) => {
    const result = computeReleaseRisk([...changedFiles], repoCount);
    expect(result.level).toBe("high");
    expect(result.reason).toContain(expectedSubstring);
  });

  it("medio: più di un repository, nessun file sensibile", () => {
    const result = computeReleaseRisk(["apps/web/src/app.tsx", "apps/server/src/routes/x.ts"], 2);
    expect(result.level).toBe("medium");
    expect(result.reason).toContain("2 repository");
  });

  it("basso: un solo repository, nessun file sensibile", () => {
    const result = computeReleaseRisk(["apps/web/src/app.tsx"], 1);
    expect(result.level).toBe("low");
  });

  it("basso: nessun file cambiato (caso limite)", () => {
    const result = computeReleaseRisk([], 1);
    expect(result.level).toBe("low");
  });

  it("combina DUE regole: multi-repo E un file ad alto rischio → vince alto, non medio", () => {
    const result = computeReleaseRisk(
      ["apps/web/src/app.tsx", "packages/db/drizzle/0075_x.sql"],
      3,
    );
    expect(result.level).toBe("high");
    expect(result.reason).toContain("migrazione");
  });

  it("il PRIMO file ad alto rischio decide la ragione (deterministico, non un set non ordinato)", () => {
    const result = computeReleaseRisk(["pnpm-lock.yaml", "packages/db/drizzle/0075_x.sql"], 1);
    expect(result.reason).toContain("lockfile");
  });

  it("un file .env NEL MEZZO del path (non come nome) non scatta — solo il basename conta", () => {
    // ".env" nel path di una CARTELLA non deve far scattare la regola sul
    // basename: è deliberatamente più stretta di un match sull'intero path.
    const result = computeReleaseRisk(["apps/web/.envexamples/readme.md"], 1);
    expect(result.level).toBe("low");
  });
});
