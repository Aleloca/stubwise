import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { catalogEntries, createRouteCollector, type CatalogEntry } from "./catalog.js";

/**
 * La fixture del pacchetto MCP (`packages/mcp/src/tools/lotto2.fixture.ts`)
 * è una copia delle voci del lotto 2: qui si confronta col catalogo vero, così
 * una voce cambiata in `config.mcp` e non ricopiata là fa fallire il test
 * (revisione del lotto 2, M2). L'import è per percorso: il pacchetto non è una
 * dipendenza del server.
 */
const FIXTURE = join(import.meta.dirname, "../../../../packages/mcp/src/tools/lotto2.fixture.ts");

describe("la fixture del lotto 2 del pacchetto MCP", () => {
  it("coincide con le voci del catalogo del server, campo per campo", async () => {
    const { LOTTO2_CATALOG } = (await import(pathToFileURL(FIXTURE).href)) as { LOTTO2_CATALOG: Omit<CatalogEntry, "instancePermission">[] };
    const collector = createRouteCollector();
    const app = buildApp({ onRoute: collector.hook });
    await app.ready();
    await app.close();
    const wanted = new Set(LOTTO2_CATALOG.map((e) => e.action));
    const server = catalogEntries(collector.routes())
      .filter((e) => wanted.has(e.action))
      .map((e) => {
        const copy: Omit<CatalogEntry, "instancePermission"> & { instancePermission?: string } = { ...e };
        delete copy.instancePermission;
        return copy;
      });
    expect(server.map((e) => e.action).sort()).toEqual([...wanted].sort());
    const byAction = (list: { action: string }[]) => [...list].sort((a, b) => a.action.localeCompare(b.action));
    expect(byAction(LOTTO2_CATALOG)).toEqual(byAction(server));
  });
});
