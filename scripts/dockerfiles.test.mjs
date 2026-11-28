// node --test scripts/dockerfiles.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copySources, instructions, problems, selected, workspacePackages } from "./dockerfiles.mjs";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Un repo finto: i pacchetti dati, e i Dockerfile dati (gli altri vuoti, con un FROM). */
function fakeRepo(pkgs, dockerfiles) {
  const root = mkdtempSync(join(tmpdir(), "sw-dockerfiles-"));
  for (const [dir, json] of Object.entries(pkgs)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
  }
  for (const f of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "package.json", "tsconfig.base.json"]) writeFileSync(join(root, f), "");
  const all = ["apps/server/Dockerfile", "apps/worker/Dockerfile", "Dockerfile.caddy", "Dockerfile.agent", "Dockerfile.push-relay", "Dockerfile.graphify"];
  for (const f of all) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), dockerfiles[f] ?? "FROM scratch\n");
  }
  return root;
}

const PKGS = {
  "apps/server": { name: "@stubwise/server", dependencies: { "@stubwise/db": "workspace:*" } },
  "packages/db": { name: "@stubwise/db", dependencies: { "@stubwise/shared": "workspace:*" } },
  "packages/shared": { name: "@stubwise/shared" },
  "packages/agent": { name: "@stubwise/agent" },
};

const GOOD = `FROM node:22-slim AS base
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/server apps/server
RUN pnpm --filter "@stubwise/server..." --filter "!@stubwise/agent" build
FROM node:22-slim AS runtime
COPY --from=base /app /app
`;

describe("i Dockerfile del repo", () => {
  it("ogni COPY esiste e ogni pacchetto compilato ha il suo manifest nel layer d'install", () => {
    assert.deepEqual(problems(repo), []);
  });
});

describe("le regole, su un repo finto", () => {
  it("un Dockerfile giusto è verde", () => {
    assert.deepEqual(problems(fakeRepo(PKGS, { "apps/server/Dockerfile": GOOD })), []);
  });

  it("#154: un COPY di un manifest che non esiste più (il web vecchio) è un problema", () => {
    const df = GOOD.replace("COPY packages/db/package.json", "COPY apps/web/package.json apps/web/package.json\nCOPY packages/db/package.json");
    const found = problems(fakeRepo(PKGS, { "apps/server/Dockerfile": df }));
    assert.deepEqual(found, ["apps/server/Dockerfile: COPY apps/web/package.json — il percorso non esiste nel repo"]);
  });

  it("una dipendenza del workspace compilata (`x...`) senza il suo manifest è un problema", () => {
    const df = GOOD.replace("COPY packages/shared/package.json packages/shared/package.json\n", "");
    const found = problems(fakeRepo(PKGS, { "apps/server/Dockerfile": df }));
    assert.equal(found.length, 1);
    assert.match(found[0], /@stubwise\/shared si compila .* packages\/shared\/package\.json non è copiato prima dell'install/);
  });

  it("un manifest copiato DOPO l'install non conta (`COPY packages packages` porta i sorgenti, non il layer)", () => {
    const df = GOOD.replace("COPY packages/db/package.json packages/db/package.json\n", "").replace(
      "COPY packages packages",
      "COPY packages packages\nCOPY packages/db/package.json packages/db/package.json",
    );
    const found = problems(fakeRepo(PKGS, { "apps/server/Dockerfile": df }));
    assert.equal(found.length, 1);
    assert.match(found[0], /@stubwise\/db si compila/);
  });

  it("un pacchetto escluso (`!x`) non serve, e un COPY --from non si cerca nel repo", () => {
    // @stubwise/agent non ha il manifest copiato ed è escluso; /app non esiste nel repo.
    assert.deepEqual(problems(fakeRepo(PKGS, { "apps/server/Dockerfile": GOOD })), []);
  });

  it("`x^...` compila le sole dipendenze, non x", () => {
    const pkgs = workspacePackages(fakeRepo(PKGS, {}));
    assert.deepEqual(selected('RUN pnpm --filter "@stubwise/server^..." build', pkgs).sort(), ["@stubwise/db", "@stubwise/shared"]);
    assert.deepEqual(selected("RUN pnpm --filter @stubwise/db build", pkgs), ["@stubwise/db"]);
    // Più comandi in fila: conta quello che compila, non quello che controlla.
    assert.deepEqual(selected("RUN pnpm --filter @stubwise/db build && pnpm --filter @stubwise/shared check:seed", pkgs), ["@stubwise/db"]);
  });

  it("le istruzioni: righe continuate unite, commenti tolti; le sorgenti di un COPY senza flag e destinazione", () => {
    assert.deepEqual(instructions("# c\nRUN a \\\n  && b\nCOPY x y\n"), ["RUN a && b", "COPY x y"]);
    assert.deepEqual(copySources("COPY --chown=w:w a b /dst/"), ["a", "b"]);
    assert.equal(copySources("COPY --from=base /app /app"), null);
  });
});
