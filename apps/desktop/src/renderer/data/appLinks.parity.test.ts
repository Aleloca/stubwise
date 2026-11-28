import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appRoute, PROJECT_CODE_PATTERN, projectCodeSchema, type AppTarget } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { isAppRoute } from "./routes";

/**
 * I link che il server scrive verso la nuova app (`@stubwise/shared`,
 * `app-links.ts`) stanno nella grammatica di questo router. Se una rotta cambia
 * qui, questo test dice quale link del server smette di aprirsi. Ogni
 * bersaglio dell'helper ha almeno un caso (`AppTarget["to"]`, controllato in
 * fondo), e i codici di progetto sono anche quelli con cifre e lunghi (TRI2,
 * STU2, WILLY2): il DB li ammette (`projectCodeSchema`).
 */
const UUID = "7b2c9d1e-4444-4555-8666-777788889999";
const CODES = ["ACQ", "TRI2", "STU2", "WILLY2"] as const;
const perCode = (code: string): AppTarget[] => [
  { to: "task", projectCode: code, taskCode: `${code}-12` },
  { to: "requests", projectCode: code },
  { to: "requests", projectCode: code, requestId: UUID },
  { to: "project", projectCode: code },
  { to: "project", projectCode: code, briefId: UUID },
  { to: "projectMembers", projectCode: code },
  { to: "docs", projectCode: code },
  { to: "productPage", projectCode: code, pageCode: `${code}-D5` },
  { to: "server", projectCode: code, serverCode: "SRV-2" },
  { to: "release", projectCode: code, releaseCode: `${code}-V3` },
  { to: "automation", automationCode: `${code}-A1` },
  { to: "automation", automationCode: `${code}-A1`, runNumber: 2 },
];
const TARGETS: AppTarget[] = [
  { to: "home" },
  ...CODES.flatMap(perCode),
  { to: "adminServer", serverCode: "SRV-2" },
  { to: "chatMessage", channelId: "ch-1", messageId: "m-1" },
  { to: "preferences", section: "security" },
  { to: "preferences", section: "account" },
  { to: "preferences", section: "notifications" },
];

/**
 * Fuori dalla grammatica di `isAppRoute`, con la loro rotta nel router:
 * - il pannello di una PR (`?pr=<repository>%23<n>`: `isAppRoute` vuole
 *   `[\w-]+`), che prova `backend/real/releasesPrsPage.test.tsx`;
 * - lo spazio Docs di un repository e una sua pagina (`/p/$code/docs/$repo`,
 *   `$slug`: rotte annidate del router, fuori dalla grammatica piatta);
 * - le pagine d'ingresso dei link delle email e del ritorno di Google;
 * - `?google=` sulle Preferenze, solo informativo (la pagina rilegge da sé).
 */
const OUTSIDE: { target: AppTarget; routerPath: string }[] = [
  { target: { to: "pullRequest", projectCode: "TRI2", repositoryId: UUID, prNumber: 88 }, routerPath: "/p/$code/releases" },
  ...CODES.flatMap((code) => [
    { target: { to: "docs", projectCode: code, repositorySlug: "web" } as AppTarget, routerPath: "/p/$code/docs/$repo" },
    { target: { to: "docs", projectCode: code, repositorySlug: "web", pageSlug: "checkout" } as AppTarget, routerPath: "$slug" },
  ]),
  { target: { to: "resetPassword", token: "t" }, routerPath: "/reset-password/$token" },
  { target: { to: "emailChange", token: "t" }, routerPath: "/email-change/$token" },
  { target: { to: "desktopGoogle", search: { outcome: "ok", state: "s" } }, routerPath: "/desktop-google" },
  { target: { to: "preferences", section: "account", search: { google: "ok" } }, routerPath: "/preferences/$section" },
];

// Dalla cartella del pacchetto, come gli altri test sul sorgente (happy-dom non dà un URL `file:`).
const SRC = join(process.cwd(), "src/renderer/");
const router = readFileSync(join(SRC, "router.tsx"), "utf8");

describe("i link del server (app-links) e la grammatica del router", () => {
  it.each(TARGETS.map((t) => [appRoute(t), t] as const))("%s è una rotta dell'app", (route) => {
    expect(isAppRoute(`#${route}`)).toBe(true);
  });

  it.each(OUTSIDE.map((o) => [appRoute(o.target), o.routerPath] as const))("%s ha la sua rotta nel router (%s)", (_route, path) => {
    // `/p/$code/releases` è la sezione (`/p/$code/$section`); le altre sono rotte esplicite.
    const declared = path === "/p/$code/releases" ? '"/p/$code/$section"' : `"${path}"`;
    expect(router).toContain(`path: ${declared}`);
  });

  it("ogni bersaglio dell'helper ha almeno un caso", () => {
    const covered = new Set([...TARGETS, ...OUTSIDE.map((o) => o.target)].map((t) => t.to));
    const all: Record<AppTarget["to"], true> = {
      home: true, task: true, requests: true, project: true, projectMembers: true, docs: true, productPage: true,
      server: true, adminServer: true, release: true, pullRequest: true, chatMessage: true, automation: true,
      preferences: true, resetPassword: true, emailChange: true, desktopGoogle: true,
    };
    expect([...covered].sort()).toEqual(Object.keys(all).sort());
  });
});

/** I sorgenti del renderer (test esclusi). */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe("il codice di un progetto ha UNA regola (projectCodeSchema)", () => {
  it("il pattern condiviso è quello di projectCodeSchema, e ammette i codici con cifre e lunghi", () => {
    for (const code of ["ACQ", "TRI2", "WIL2", "STU2", "WILLY2"]) {
      expect(projectCodeSchema.safeParse(code).success).toBe(true);
      expect(new RegExp(`^${PROJECT_CODE_PATTERN}$`).test(code)).toBe(true);
    }
  });

  it("nessun sorgente del renderer usa la vecchia regola stretta `[A-Z]{2,4}`", () => {
    const stale = sources(SRC).filter((f) => readFileSync(f, "utf8").includes("[A-Z]{2,4}"));
    expect(stale.map((f) => f.slice(SRC.length))).toEqual([]);
  });
});
