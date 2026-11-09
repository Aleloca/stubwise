import { describe, expect, it as test } from "vitest";
import en from "./locales/en.json";
import it from "./locales/it.json";

type Tree = { [key: string]: string | Tree };

function flattenKeys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

describe("i nomi delle destinazioni in italiano", () => {
  test("la Panoramica non si chiama «Overview» in nessuna frase (la colonna dice «Panoramica»)", () => {
    const values: string[] = [];
    const walk = (o: unknown): void => {
      if (typeof o === "string") values.push(o);
      else if (o && typeof o === "object") Object.values(o).forEach(walk);
    };
    walk(it);
    expect(values.filter((v) => v.includes("Overview"))).toEqual([]);
  });
});

describe("parità delle chiavi en/it", () => {
  test("stesse chiavi (anche annidate) in en e it", () => {
    expect(flattenKeys(it as Tree).sort()).toEqual(flattenKeys(en as Tree).sort());
  });

  test("le chiavi radice previste ci sono", () => {
    expect(Object.keys(en).sort()).toEqual(
      [
        "alerts",
        "automations",
        "column",
        "common",
        "export",
        "chat",
        "changelog",
        "claude",
        "docs",
        "drive",
        "filter",
        "home",
        "modules",
        "nav",
        "notFound",
        "notifications",
        "palette",
        "placeholder",
        "prefs",
        "productDocs",
        "releases",
        "servers",
        "support",
        "project",
        "rail",
        "taskUi",
        "tasks",
        "taskDetail",
        "newTask",
        "week",
        "planning",
        "requests",
        "overview",
        "projects",
        "settings",
        "mail",
        "calendar",
        "whoCan",
        "entry",
        "permissions",
        "admin",
        // Area 9b: i nomi delle operazioni AI (`usage.operations.<op>`), del
        // registro e delle schede Models e Usage.
        "usage",
        // Area 9b, Task 6: le frasi dei blocchi d'istanza nelle altre aree
        // (budget, coda in pausa, caricamenti spenti, modello e account).
        "instanceEffects",
        // Area 9c, Task 6: gli effetti delle impostazioni di progetto nelle
        // altre aree (brief, Docs notturni, pulse, report, account, skill).
        "projectEffects",
        // Area 10a, Task 10: «Elimina task» (`task.delete.*`).
        "task",
        // Area 10a, Task 11: «with Claude» e «Claude on behalf of» nella
        // storia della task, nella rassegna e nella storia del progetto.
        "activity",
      ].sort(),
    );
  });
});
