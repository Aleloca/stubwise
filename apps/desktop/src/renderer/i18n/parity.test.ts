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
      ].sort(),
    );
  });
});
