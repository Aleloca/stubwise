import { hasPermission } from "./permissions";

// L'app non ha `@types/node` (è un package React Native): il test della guardia
// legge i sorgenti con `fs`, dichiarato qui il minimo che serve.
declare const __dirname: string;
declare const require: (module: string) => unknown;
const { readFileSync, readdirSync, statSync } = require("fs") as {
  readFileSync: (path: string, encoding: "utf8") => string;
  readdirSync: (path: string) => string[];
  statSync: (path: string) => { isDirectory: () => boolean };
};
const join = (...parts: string[]): string => parts.join("/");

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("hasPermission", () => {
  test("un permesso d'istanza si legge da instancePermissions", () => {
    const me = { instancePermissions: ["projects.create"], projectPermissions: {} };
    expect(hasPermission(me, "projects.create")).toBe(true);
    expect(hasPermission(me, "users.manage")).toBe(false);
  });

  test("un permesso di progetto vale solo nel suo progetto", () => {
    const me = { instancePermissions: [], projectPermissions: { [PROJECT_A]: ["plans.approve"] } };
    expect(hasPermission(me, "plans.approve", PROJECT_A)).toBe(true);
    expect(hasPermission(me, "plans.approve", PROJECT_B)).toBe(false);
  });

  test("senza projectId, un permesso di progetto vuol dire «in almeno un progetto»", () => {
    const me = { instancePermissions: [], projectPermissions: { [PROJECT_A]: ["release.merge"] } };
    expect(hasPermission(me, "release.merge")).toBe(true);
    expect(hasPermission(me, "repos.manage")).toBe(false);
  });

  test("un full admin ha tutto, anche su un progetto che /me non elenca", () => {
    const me = { instancePermissions: ["instance.full_admin"], projectPermissions: {} };
    expect(hasPermission(me, "plans.approve", PROJECT_B)).toBe(true);
    expect(hasPermission(me, "plugins.manage")).toBe(true);
  });

  test("una risposta /me senza i campi dei permessi (doppio dei test, server vecchio) = nessun permesso", () => {
    expect(hasPermission({}, "projects.create")).toBe(false);
    expect(hasPermission({}, "plans.approve", PROJECT_A)).toBe(false);
    expect(hasPermission(undefined, "projects.create")).toBe(false);
  });
});

/**
 * GUARDIA: l'app non decide più per ruolo (22 ott 2026). Ogni decisione legge i
 * permessi calcolati dal server (`useCan`, `hasPermission`, `myPermissions`);
 * un confronto col ruolo dell'utente o un `isAdmin` che ricompare nel codice
 * (non nei test) fa fallire questo test. Non coglie `message.role` o
 * `bubble.role` (ruoli di chat): solo il ruolo dell'utente.
 */
describe("nessuna decisione per ruolo nell'app", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === "test-utils" ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  const FORBIDDEN = [
    /\bisAdmin\b/,
    /\.user\??\.role\b/,
    /\buser\??\.role\s*[!=]==?/,
    /\brole\s*[!=]==?\s*["'](admin|member)["']/,
    /["'](admin|member)["']\s*[!=]==?\s*\w*\.?role\b/,
  ];

  const files = sources(join(__dirname, ".."));

  test("legge abbastanza sorgenti da essere significativo", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test("nessun sorgente confronta il ruolo dell'utente", () => {
    const offenders = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
        .filter(({ line }) => FORBIDDEN.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
