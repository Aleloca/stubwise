// node --test scripts/check-esm-named-imports.test.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { check, namedImports } from "./check-esm-named-imports.mjs";

const root = mkdtempSync(join(tmpdir(), "esm-check-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** Un package con un dist/ e un pacchetto CommonJS nelle sue node_modules. */
function pkg(name, distSource, cjsSource) {
  const dir = join(root, name);
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "cjs-dep"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module" }));
  writeFileSync(join(dir, "node_modules", "cjs-dep", "package.json"), JSON.stringify({ name: "cjs-dep", main: "index.js" }));
  writeFileSync(join(dir, "node_modules", "cjs-dep", "index.js"), cjsSource);
  writeFileSync(join(dir, "dist", "mod.js"), distSource);
  writeFileSync(join(dir, "dist", "mod.test.js"), 'import { nonEsiste } from "cjs-dep";\n');
  return join(dir, "dist");
}

describe("check-esm-named-imports", () => {
  it("un nome che un CommonJS non espone a cjs-module-lexer è un problema (il caso ssh2/utils)", () => {
    // Come ssh2: l'oggetto si costruisce a runtime, il lexer non vede `utils`.
    const dist = pkg("a", 'import { Client, utils as u } from "cjs-dep";\nimport { join } from "node:path";\nimport { x } from "./local.js";\n', "const api = {}; api.utils = {}; exports.Client = class {}; module.exports = Object.assign(module.exports, api);\n");
    const problems = check([dist]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\{ utils \} da "cjs-dep"/);
  });

  it("gli export che il lexer vede passano; i test compilati si saltano", () => {
    const dist = pkg("b", 'import { Client } from "cjs-dep";\nimport dflt from "cjs-dep";\n', "exports.Client = class {};\n");
    assert.deepEqual(check([dist]), []);
  });

  it("un pacchetto che non si risolve è un problema", () => {
    const dist = pkg("c", 'import { y } from "manca-del-tutto";\n', "exports.a = 1;\n");
    assert.match(check([dist])[0], /"manca-del-tutto" non si carica/);
  });

  it("namedImports: alias, default più nomi, import di tipo e multi-riga", () => {
    assert.deepEqual(namedImports('import d, { a as b,\n  c } from "p";\nimport { type T, e } from "q";'), [
      { spec: "p", names: ["a", "c"] },
      { spec: "q", names: ["e"] },
    ]);
  });
});
