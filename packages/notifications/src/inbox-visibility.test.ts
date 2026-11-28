import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ALERT_TYPES, isLiveAlertType } from "@stubwise/shared";
import { catalogPermissionVisible, notificationVisibleToRecipient } from "./inbox-visibility.js";

const render = (s: ReturnType<typeof catalogPermissionVisible>) => new PgDialect().sqlToQuery(s).sql;
// `pa_a` è l'alias della sottoquery dei ruoli in `projectAccessPermissionsSql`:
// una occorrenza = i permessi del destinatario calcolati UNA volta.
const permissionLookups = (text: string) => (text.match(/"project_access" pa_a\b/g) ?? []).length;

describe("I1: i permessi della card si calcolano UNA volta per riga, non una per tipo", () => {
  it("il filtro del catalogo ha una sola lettura dei permessi, qualunque sia il numero di tipi col permesso", () => {
    const live = ALERT_TYPES.filter((t) => isLiveAlertType(t.type));
    expect(live.filter((t) => t.subscribe.perm !== "member").length).toBeGreaterThan(1);
    expect(permissionLookups(render(catalogPermissionVisible(live)))).toBe(1);
    expect(permissionLookups(render(notificationVisibleToRecipient()))).toBe(1);
  });
});
