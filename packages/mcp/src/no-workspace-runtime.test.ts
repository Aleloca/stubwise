import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Il pacchetto pubblicato dipende a runtime SOLO dalle sue `dependencies`
 * (revisione finale della parità MCP, C1). `@stubwise/shared` è una
 * devDependency: nel monorepo si risolve sempre, quindi un import di VALORE
 * da lì passa build e test e rompe il pacchetto su npm per tutti
 * (`ERR_MODULE_NOT_FOUND`). Qui: ogni import o export da `@stubwise/…` nei
 * sorgenti (test e fixture esclusi) è `import type`/`export type`. Il gemello
 * sul dist è `scripts/smoke-mcp-dist-isolated.mjs`, in `pnpm check:dist`.
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((f) => {
    const full = join(dir, f.name);
    if (f.isDirectory()) return sources(full);
    return f.name.endsWith(".ts") && !f.name.endsWith(".test.ts") && !f.name.endsWith(".fixture.ts") ? [full] : [];
  });
}

/** Gli import e gli export da `@stubwise/…` che restano nel JavaScript emesso. */
function runtimeWorkspaceImports(source: string): string[] {
  const out: string[] = [];
  const statements = source.matchAll(/(?:^|\n)\s*(import|export)\s+([^;]*?)\s+from\s+["'](@stubwise\/[^"']+)["']/g);
  for (const m of statements) {
    const clause = m[2]!.trim();
    if (clause.startsWith("type ") || clause.startsWith("type{")) continue;
    // `import { type A, type B }`: tutto tipo, cancellato.
    const named = /^\{([^}]*)\}$/.exec(clause);
    if (named && named[1]!.split(",").map((x) => x.trim()).filter(Boolean).every((x) => x.startsWith("type "))) continue;
    out.push(`${m[1]} ${clause} from "${m[3]}"`);
  }
  for (const m of source.matchAll(/import\(\s*["'](@stubwise\/[^"']+)["']\s*\)/g)) out.push(`import("${m[1]}")`);
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+["'](@stubwise\/[^"']+)["']/g)) out.push(`import "${m[1]}"`);
  return out;
}

describe("il pacchetto non importa VALORI dai package del workspace", () => {
  it("la regola riconosce le forme", () => {
    expect(runtimeWorkspaceImports('import type { A } from "@stubwise/shared";')).toEqual([]);
    expect(runtimeWorkspaceImports('import { type A, type B } from "@stubwise/shared";')).toEqual([]);
    expect(runtimeWorkspaceImports('import { addWeeks } from "@stubwise/shared";')).toHaveLength(1);
    expect(runtimeWorkspaceImports('import { type A, b } from "@stubwise/shared";')).toHaveLength(1);
    expect(runtimeWorkspaceImports('export { x } from "@stubwise/shared";')).toHaveLength(1);
    expect(runtimeWorkspaceImports('const m = await import("@stubwise/shared");')).toHaveLength(1);
    expect(runtimeWorkspaceImports('import "@stubwise/shared";')).toHaveLength(1);
    expect(runtimeWorkspaceImports('import {\n  a,\n  type B,\n} from "@stubwise/db";')).toHaveLength(1);
  });

  it("nessun sorgente del pacchetto ne ha", () => {
    const found = sources(SRC).flatMap((f) => runtimeWorkspaceImports(readFileSync(f, "utf8")).map((i) => `${relative(SRC, f)}: ${i}`));
    expect(found).toEqual([]);
  });
});
