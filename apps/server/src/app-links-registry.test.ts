import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ritiro del web vecchio (design `docs/plans/2026-11-27-link-nuova-app-design.md`):
 * i link verso Stubwise che server, worker, notifiche, SDK, MCP e gli altri
 * pacchetti scrivono (card, email, push, webhook, risposte) si costruiscono
 * in UN posto, `packages/shared/src/app-links.ts`. Qui si legge il SORGENTE
 * (`.ts`, `.tsx`, `.mjs`) e si fa fallire, in ogni stringa:
 * - un PERCORSO del web vecchio, riconosciuto dal prefisso (`/tickets`,
 *   `/backlog`, `/projects/`, `/docs/`, `/monitor/servers`, ogni
 *   `/settings/…`, `/agents/job`, `/roadmap`, `/inbox`), anche concatenato o
 *   senza id: quelli che servono ancora, finché il web vecchio esiste, stanno
 *   in `legacyWebPath`;
 * - un link della nuova app scritto a mano: `/app/#` o un frammento `#/…`.
 * Non contano: le stringhe che INIZIANO con `/api/` (le rotte dell'API), i
 * pattern delle rotte del server (`/tickets/:id`…, coi loro parametri), gli
 * specificatori dei moduli, i commenti, i test.
 * Il renderer della nuova app (`apps/desktop`) e il web vecchio (`apps/web`)
 * sono fuori: sono le app che quei percorsi li SERVONO.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXCLUDED_APPS = new Set(["web", "desktop", "docs"]);
const SCANNED = [
  ...readdirSync(join(ROOT, "apps")).filter((a) => !EXCLUDED_APPS.has(a)).map((a) => `apps/${a}/src`),
  ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/src`),
].filter((dir) => existsSync(join(ROOT, dir)));
/** L'unico posto che scrive i link (e i percorsi del web vecchio che restano). */
const HOME = "packages/shared/src/app-links.ts";
/** I rimandi del web vecchio: lì i percorsi vecchi sono le ROTTE che li ricevono. */
const LEGACY_ROUTES = "apps/server/src/routes/go.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "__tests__"].includes(entry.name) ? [] : sources(full);
    if (/\.(test|fixture|spec)\.(ts|tsx|mjs)$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [full] : [];
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

/** Il primo segmento di un percorso del web vecchio. */
const LEGACY = /^\/(?:(?:tickets|backlog|monitor\/servers|agents\/job|roadmap|inbox)(?:[/?#$]|$)|(?:projects|docs|settings)\/)/;

/**
 * Il percorso dell'istanza che una stringa compone: la stringa stessa (un
 * pezzo concatenato, `"/tickets/"`), quello dopo una base interpolata in testa
 * (`${base}/tickets/…`) o dopo l'host di un indirizzo (`https://x/inbox`).
 * Un indirizzo d'altri (`https://fcm.googleapis.com/v1/projects/…`) ha il suo
 * primo segmento, che non è uno dei nostri.
 */
function instancePath(body: string): string {
  // Solo una base che è la radice dell'istanza (`base`, `publicUrl`,
  // `baseUrl`, `root(…)`): `${GMAIL_API_BASE}/settings/…` è l'API di Google.
  const afterBase = /^\$\{([^}]*)\}(.*)$/.exec(body);
  if (afterBase) return /publicurl|baseurl|^base$|^root\(/i.test(afterBase[1]!.trim()) ? afterBase[2]! : "";
  const afterHost = /^https?:\/\/[^/]+(\/.*)?$/.exec(body);
  if (afterHost) return afterHost[1] ?? "";
  return body;
}

/** Le posizioni dei primi argomenti di `app.get(` & co.: le rotte registrate, non link. */
function routeLiterals(code: string): Set<string> {
  return new Set([...code.matchAll(/\b(?:app|instance|fastify)\.(?:get|post|put|patch|delete|head|all)\(\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => m[1]!));
}

export function violationsIn(path: string, text: string): string[] {
  if (path === HOME || path === LEGACY_ROUTES) return [];
  const out: string[] = [];
  const code = withoutComments(text);
  const routes = routeLiterals(code);
  for (const literal of literals(code)) {
    if (routes.has(literal)) continue;
    const body = literal.slice(1, -1);
    if (body.startsWith("/api/")) continue;
    // Gli specificatori dei moduli (`"../backlog/provider.js"`) non sono link.
    if (/^\.\.?\//.test(body)) continue;
    // Un pattern di rotta del server (`/tickets/:id/…`): una rotta registrata, non un link.
    if (/^\/[\w/-]*\/:\w/.test(body)) continue;
    if (body.includes("/app/#") || /(?:^|[^\w&])#\//.test(body)) out.push(`${path}: link della nuova app scritto a mano: ${literal.slice(0, 120)}`);
    if (LEGACY.test(instancePath(body))) out.push(`${path}: percorso del web vecchio: ${literal.slice(0, 120)}`);
  }
  return out;
}

describe("i link della nuova app si costruiscono in UN posto (app-links)", () => {
  it("nessun sorgente fuori dalle due app scrive a mano un percorso del web vecchio o un link della nuova app", () => {
    const found = SCANNED.flatMap((dir) =>
      sources(join(ROOT, dir)).flatMap((file) => violationsIn(relative(ROOT, file), readFileSync(file, "utf8"))),
    );
    expect(found).toEqual([]);
  });

  it("il controllo vede davvero i casi (un test che non può fallire non prova niente)", () => {
    const seen = (code: string) => violationsIn("x.ts", code).length;
    expect(seen("const u = `${base}/tickets/${id}`;")).toBe(1);
    expect(seen("const u = base + \"/tickets/\" + id;")).toBe(1);
    expect(seen("const u = `${base}/backlog?projectId=${id}`;")).toBe(1);
    expect(seen("const u = `${base}/backlog`;")).toBe(1);
    expect(seen('const u = base + "/settings/security";')).toBe(1);
    expect(seen('const u = base + "/settings/usage";')).toBe(1);
    expect(seen("const u = `https://x.test/inbox`;")).toBe(1);
    expect(seen("const u = `${base}/app/#/p/${code}/docs`;")).toBe(1);
    expect(seen("const r = `#/automations/${code}`;")).toBe(1);
    // Le rotte dell'API, i pattern di rotta, i moduli, i commenti e app-links.ts no.
    expect(seen("fetch(`/api/tickets/${id}`);")).toBe(0);
    expect(seen('app.get("/tickets/:id/history", h);')).toBe(0);
    expect(seen('app.get(\n  "/docs/spaces",\n  h);')).toBe(0);
    expect(seen("fetch(`${GMAIL_API_BASE}/settings/sendAs`);")).toBe(0);
    expect(seen("const u = `${deps.publicUrl}/settings/security`;")).toBe(1);
    expect(seen('import x from "../backlog/provider.js";')).toBe(0);
    expect(seen("// il vecchio `${base}/tickets/${id}`\n/* `/app/#/x` */")).toBe(0);
    expect(violationsIn(HOME, "const u = `/app/#/x`;")).toEqual([]);
  });
});
