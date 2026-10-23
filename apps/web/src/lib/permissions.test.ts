import { describe, expect, it } from "vitest";
import { hasPermission } from "./permissions";

const PROJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("hasPermission", () => {
  it("un permesso d'istanza si legge da instancePermissions", () => {
    const me = { instancePermissions: ["projects.create"], projectPermissions: {} };
    expect(hasPermission(me, "projects.create")).toBe(true);
    expect(hasPermission(me, "users.manage")).toBe(false);
  });

  it("un permesso di progetto vale solo nel suo progetto", () => {
    const me = { instancePermissions: [], projectPermissions: { [PROJECT_A]: ["plans.approve"] } };
    expect(hasPermission(me, "plans.approve", PROJECT_A)).toBe(true);
    expect(hasPermission(me, "plans.approve", PROJECT_B)).toBe(false);
  });

  it("senza projectId, un permesso di progetto vuol dire «in almeno un progetto»", () => {
    const me = { instancePermissions: [], projectPermissions: { [PROJECT_A]: ["release.merge"] } };
    expect(hasPermission(me, "release.merge")).toBe(true);
    expect(hasPermission(me, "repos.manage")).toBe(false);
  });

  it("un full admin ha tutto, anche su un progetto che /me non elenca", () => {
    const me = { instancePermissions: ["instance.full_admin"], projectPermissions: {} };
    expect(hasPermission(me, "plans.approve", PROJECT_B)).toBe(true);
    expect(hasPermission(me, "plugins.manage")).toBe(true);
  });

  it("una risposta /me senza i campi dei permessi (server più vecchio) = nessun permesso", () => {
    expect(hasPermission({}, "projects.create")).toBe(false);
    expect(hasPermission({}, "plans.approve", PROJECT_A)).toBe(false);
    expect(hasPermission(undefined, "projects.create")).toBe(false);
  });
});

/**
 * GUARDIA: il web non decide più per ruolo (22 ott 2026). Ogni decisione legge
 * i permessi calcolati dal server (`useCan`, `hasPermission`); un confronto
 * col ruolo dell'utente o un `isAdmin` che ricompare nel codice (non nei test)
 * fa fallire questo test. Non coglie `message.role` o `ticket.role` (ruoli di
 * un messaggio di chat o del legame ticket↔voce, che con l'utente non
 * c'entrano): solo il ruolo dell'utente e i nomi dei ruoli di prima.
 */
describe("nessuna decisione per ruolo nel web", () => {
  const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../test/**"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const FORBIDDEN = [
    /\bisAdmin\b/,
    /\.user\??\.role\b/,
    /\brole\s*[!=]==?\s*["'](admin|member)["']/,
    /["'](admin|member)["']\s*[!=]==?\s*\w*\.?role\b/,
  ];

  it("legge abbastanza sorgenti da essere significativo", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
  });

  it("nessun sorgente confronta il ruolo dell'utente", () => {
    const offenders = Object.entries(sources).flatMap(([path, text]) =>
      text
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => FORBIDDEN.some((pattern) => pattern.test(line)))
        .map(({ line, index }) => `${path}:${index + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
