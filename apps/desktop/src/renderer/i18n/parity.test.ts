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
      ].sort(),
    );
  });
});
