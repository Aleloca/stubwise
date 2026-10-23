import { INSTANCE_PERMISSIONS, PROJECT_PERMISSIONS } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import it_ from "../i18n/locales/it.json";
import { INSTANCE_PERMISSION_GROUPS, PROJECT_PERMISSION_GROUPS } from "./permission-groups";

/**
 * I gruppi della pagina Ruoli coprono il catalogo per intero, senza doppioni:
 * una chiave fuori da ogni gruppo non comparirebbe fra le caselle.
 */
describe("gruppi dei permessi", () => {
  it.each([
    ["instance", INSTANCE_PERMISSION_GROUPS, INSTANCE_PERMISSIONS],
    ["project", PROJECT_PERMISSION_GROUPS, PROJECT_PERMISSIONS],
  ] as const)("%s: ogni chiave del catalogo sta in esattamente un gruppo", (_scope, groups, catalog) => {
    const grouped = groups.flatMap((group) => [...group.permissions]);
    expect(grouped.length).toBe(new Set(grouped).size);
    expect([...grouped].sort()).toEqual([...catalog].sort());
  });

  it("ogni gruppo ha un'etichetta in entrambe le lingue", () => {
    const ids = [...INSTANCE_PERMISSION_GROUPS, ...PROJECT_PERMISSION_GROUPS].map((g) => g.id);
    for (const locale of [en, it_]) {
      const labels = (locale.settings as { roles: { groups: Record<string, string> } }).roles.groups;
      for (const id of ids) expect(labels[id], id).toBeTruthy();
    }
  });
});
