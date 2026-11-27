import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ritiro del web vecchio (design `docs/plans/2026-11-27-link-nuova-app-design.md`):
 * i link verso Stubwise che server, worker, notifiche, SDK e MCP scrivono (card,
 * email, push, webhook, risposte) si costruiscono in UN posto,
 * `packages/shared/src/app-links.ts`. Qui si legge il SORGENTE e si fa fallire:
 * - un percorso del web vecchio scritto a mano (`/tickets/${…}`, `/backlog/…`,
 *   `/projects/${…}`, `/docs/${…}`, `/monitor/servers/…`, `/settings/…`,
 *   `/agents/job/…`, `/roadmap`): quelli che servono ancora, finché il web
 *   vecchio esiste, stanno in `legacyWebPath`;
 * - un `/app/#` fuori da `app-links.ts`: il giorno in cui `/app` passa alla
 *   radice deve bastare cambiare `APP_ENTRY`.
 * Le stringhe che contengono `/api/` (le rotte dell'API) non contano, né i
 * commenti, né i test.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED = [
  "apps/server/src",
  "apps/worker/src",
  "packages/notifications/src",
  "packages/shared/src",
  "packages/mcp/src",
  "packages/sdk/src",
];
/** L'unico posto che scrive i link (e i percorsi del web vecchio che restano). */
const HOME = "packages/shared/src/app-links.ts";
/**
 * I rimandi del web vecchio: lì i percorsi vecchi sono le ROTTE che li
 * ricevono (`/go/tickets/:id`…), non link scritti; i link che producono
 * passano dall'helper (`appPath`).
 */
const LEGACY_ROUTES = "apps/server/src/routes/go.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(full);
    const testLike = /\.(test|fixture)\.ts$/.test(entry.name) || full.includes(`${"/"}test${"/"}`);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && !testLike ? [full] : [];
  });
}

/** Il codice senza commenti (blocchi e righe che iniziano con `//`): restano le stringhe. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** Le stringhe del codice: template, apici doppi e singoli (approssimato, basta qui). */
function literals(code: string): string[] {
  return [...code.matchAll(/`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g)].map((m) => m[0]);
}

const LEGACY = [
  /\/tickets\/\$\{/,
  /\/backlog(\/\$\{|\?|\/[a-z0-9-]{8,})/,
  /\/projects\/\$\{/,
  /\/docs\/\$\{/,
  /\/monitor\/servers\//,
  /\/settings\/(security|account|notifications|usage)\b/,
  /\/agents\/job\//,
  /\/roadmap\b/,
];

export function violationsIn(path: string, text: string): string[] {
  if (path === HOME || path === LEGACY_ROUTES) return [];
  const out: string[] = [];
  for (const literal of literals(withoutComments(text))) {
    if (literal.includes("/api/")) continue;
    // Gli specificatori dei moduli (`"../backlog/provider.js"`) non sono link.
    if (/^["'`]\.\.?\//.test(literal)) continue;
    if (literal.includes("/app/#")) out.push(`${path}: link della nuova app scritto a mano: ${literal.slice(0, 120)}`);
    for (const re of LEGACY) if (re.test(literal)) out.push(`${path}: percorso del web vecchio: ${literal.slice(0, 120)}`);
  }
  return out;
}

describe("i link della nuova app si costruiscono in UN posto (app-links)", () => {
  it("nessun sorgente di server, worker, notifiche, shared, MCP e SDK scrive a mano un percorso del web vecchio o un /app/#", () => {
    const found = SCANNED.flatMap((dir) =>
      sources(join(ROOT, dir)).flatMap((file) => violationsIn(relative(ROOT, file), readFileSync(file, "utf8"))),
    );
    expect(found).toEqual([]);
  });

  it("il controllo vede davvero i casi (un test che non può fallire non prova niente)", () => {
    expect(violationsIn("x.ts", "const u = `${base}/tickets/${id}`;")).toHaveLength(1);
    expect(violationsIn("x.ts", "const u = `${base}/backlog?projectId=${id}`;")).toHaveLength(1);
    expect(violationsIn("x.ts", 'const u = base + "/settings/security";')).toHaveLength(1);
    expect(violationsIn("x.ts", "const u = `${base}/app/#/p/${code}/docs`;")).toHaveLength(1);
    // Le rotte dell'API, i commenti e app-links.ts no.
    expect(violationsIn("x.ts", "fetch(`${base}/api/tickets/${id}`);")).toEqual([]);
    expect(violationsIn("x.ts", "// il vecchio `${base}/tickets/${id}`\n/* `/app/#/x` */")).toEqual([]);
    expect(violationsIn(HOME, "const u = `/app/#/x`;")).toEqual([]);
  });
});
