#!/usr/bin/env node
// Genera `src/renderer/data/backend/real/stubs.generated.ts`: per ogni
// esportazione di valore di `src/renderer/data/api.ts` (il livello dati finto)
// uno stub «non integrato», così la build «app» ha lo stesso insieme di nomi
// del prototipo e una pagina non integrata fallisce con `NotIntegratedError`
// invece di chiamare `undefined`. Le esportazioni implementate davvero stanno
// in `real/index.ts` e prevalgono sulla stella.
//
// Uso: `pnpm --filter @stubwise/desktop gen:stubs` (o `node scripts/gen-backend-stubs.mjs`
// da `apps/desktop`). Il test `data/backend/seam.test.ts` fallisce se il file
// non copre più ogni nome del finto: lì si rilancia questo script.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiFile = resolve(root, "src/renderer/data/api.ts");
const outFile = resolve(root, "src/renderer/data/backend/real/stubs.generated.ts");

const configPath = resolve(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram({ rootNames: [apiFile], options: parsed.options });
const checker = program.getTypeChecker();
const source = program.getSourceFile(apiFile);
if (!source) throw new Error(`non trovo ${apiFile}`);
const moduleSymbol = checker.getSymbolAtLocation(source);
if (!moduleSymbol) throw new Error(`${apiFile} non è un modulo`);

/** Un'esportazione `export type { … }` (o `export { type X }`): nessun valore a runtime. */
function isTypeOnlyExport(symbol) {
  return (symbol.declarations ?? []).some(
    (d) =>
      (ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)) ||
      (ts.isNamespaceExport?.(d) && d.parent.isTypeOnly),
  );
}

function isPromise(type) {
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  return symbol?.getName() === "Promise";
}

const entries = [];
for (const exported of checker.getExportsOfModule(moduleSymbol)) {
  const name = exported.getName();
  if (isTypeOnlyExport(exported)) continue;
  const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  if (target.flags & ts.SymbolFlags.ValueModule) {
    entries.push({ name, kind: "namespace" });
    continue;
  }
  if (!(target.flags & ts.SymbolFlags.Value)) continue;
  const type = checker.getTypeOfSymbolAtLocation(exported, source);
  const signatures = type.getCallSignatures();
  if (signatures.length > 0) {
    const async = signatures.every((s) => isPromise(checker.getReturnTypeOfSignature(s)));
    entries.push({ name, kind: async ? "async" : "sync" });
    continue;
  }
  // Una costante di configurazione (es. `MENTION_LIMIT`) non è un dato del
  // seme: con un tipo letterale si copia com'è.
  if (type.isNumberLiteral() || type.isStringLiteral()) {
    entries.push({ name, kind: "literal", value: JSON.stringify(type.value) });
    continue;
  }
  if (type.flags & ts.TypeFlags.BooleanLiteral) {
    entries.push({ name, kind: "literal", value: checker.typeToString(type) });
    continue;
  }
  entries.push({ name, kind: "value" });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const line = (e) => {
  const type = `typeof Fake.${e.name}`;
  switch (e.kind) {
    case "namespace":
      return `export const ${e.name}: ${type} = notIntegratedNamespace("${e.name}") as never;`;
    case "async":
      return `export const ${e.name}: ${type} = notIntegrated("${e.name}") as never;`;
    case "sync":
      return `export const ${e.name}: ${type} = notIntegratedSync("${e.name}") as never;`;
    case "literal":
      return `export const ${e.name}: ${type} = ${e.value};`;
    case "value":
      return `export const ${e.name}: ${type} = notIntegratedValue("${e.name}") as never;`;
  }
};

const header = `// GENERATO da \`scripts/gen-backend-stubs.mjs\` — non modificare a mano.
// Rilancia \`pnpm --filter @stubwise/desktop gen:stubs\` quando cambiano le
// esportazioni di \`data/api.ts\` (lo dice \`data/backend/seam.test.ts\`).
import type * as Fake from "../../api";
import {
  notIntegrated,
  notIntegratedNamespace,
  notIntegratedSync,
  notIntegratedValue,
} from "./notIntegrated";
`;

const used = new Set(entries.map((e) => e.kind));
let out = `${header}\n${entries.map(line).join("\n")}\n`;
// Niente import inutilizzati (lint): toglie gli helper che nessuna riga usa.
for (const [kind, helper] of [
  ["namespace", "notIntegratedNamespace"],
  ["async", "notIntegrated"],
  ["sync", "notIntegratedSync"],
  ["value", "notIntegratedValue"],
]) {
  if (!used.has(kind)) out = out.replace(`  ${helper},\n`, "");
}
writeFileSync(outFile, out);
const counts = Object.fromEntries([...used].map((k) => [k, entries.filter((e) => e.kind === k).length]));
console.log(`stubs.generated.ts: ${entries.length} esportazioni`, counts);
