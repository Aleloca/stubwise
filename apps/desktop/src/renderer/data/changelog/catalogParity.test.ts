import { CHANGE_LOG_TYPES } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { ADMIN_CHANGE_TYPES } from "../admin/changeTypes";
import { INSTANCE_CHANGE_TYPES } from "../instance/changeTypes";
import { PROJECT_CHANGE_TYPES } from "../projectSettings/changeTypes";

// Area 9, F2: la terza gamba della parità del registro delle modifiche. Il
// catalogo del server (`CHANGE_LOG_TYPES` di `@stubwise/shared`) ha i tipi del
// prototipo (G-1 = a): ogni tipo c'è anche qui, con lo stesso scope, gruppo e
// permesso di lettura, e con la sua frase (`changelog.kinds.<kind>`) nelle due
// lingue. Un tipo nuovo sul server senza il suo template fa fallire questo test.

/** Il valore di un percorso `a.b.c` in un oggetto di traduzioni. */
function at(tree: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node && typeof node === "object" && key in (node as object))
      return (node as Record<string, unknown>)[key];
    return undefined;
  }, tree);
}

describe("il catalogo del registro: server, prototipo e frasi (area 9, F2)", () => {
  /**
   * In attesa di 72 (decisione del maintainer del 31 ott 2026: è d'istanza): il
   * catalogo del server lo ha ancora di progetto. Si toglie quando 72 allinea.
   */
  const AWAITING_SERVER = new Set(["repository.deleted"]);

  it.each(
    CHANGE_LOG_TYPES.filter((t) => !AWAITING_SERVER.has(t.kind)).map((t) => [t.kind, t] as const),
  )("%s", (kind, server) => {
    // F5: anche i tipi delle impostazioni di progetto (9c).
    const proto = [...ADMIN_CHANGE_TYPES, ...INSTANCE_CHANGE_TYPES, ...PROJECT_CHANGE_TYPES].find(
      (t) => t.kind === kind,
    );
    expect(proto, `${kind} manca nel prototipo`).toBeDefined();
    expect({
      scope: proto!.scope,
      group: proto!.group,
      readPermission: proto!.readPermission,
    }).toEqual({
      scope: server.scope,
      group: server.group,
      readPermission: server.readPermission,
    });
    for (const [lang, tree] of [
      ["en", en],
      ["it", it_],
    ] as const) {
      const text = at(tree, `changelog.kinds.${kind}`);
      expect(
        typeof text === "string" || (typeof text === "object" && text !== null),
        `${lang}: changelog.kinds.${kind}`,
      ).toBe(true);
    }
  });

  it("il prototipo non ha tipi d'amministrazione che il server non conosce", () => {
    const server = new Set<string>(CHANGE_LOG_TYPES.map((t) => t.kind));
    expect(ADMIN_CHANGE_TYPES.map((t) => t.kind).filter((k) => !server.has(k))).toEqual([]);
  });

  // F3: i tipi d'istanza della 9b. Quelli che il server non scrive ancora
  // (i server: area 8) sono un elenco DICHIARATO, così un tipo
  // nuovo solo nel prototipo si nota.
  it("i tipi d'istanza del prototipo: o il server li conosce, o sono fra quelli dichiarati", () => {
    const server = new Set<string>(CHANGE_LOG_TYPES.map((t) => t.kind));
    expect(
      INSTANCE_CHANGE_TYPES.map((t) => t.kind)
        .filter((k) => !server.has(k))
        .sort(),
    ).toEqual(
      [
        "server.agent_key_regenerated",
        "server.check_changed",
        "server.created",
        "server.deleted",
        "server.ssh_access_changed",
        "server.thresholds_changed",
        "server.updated",
      ].sort(),
    );
  });
});
