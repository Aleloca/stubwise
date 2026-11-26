import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { catalogEntries, createRouteCollector, type CatalogEntry } from "./catalog.js";

/**
 * Le fixture del pacchetto MCP (`packages/mcp/src/tools/lotto<N>.fixture.ts`)
 * sono copie delle voci di un lotto: qui si confrontano col catalogo vero,
 * così una voce cambiata in `config.mcp` e non ricopiata là fa fallire il
 * test (revisione del lotto 2, M2). L'import è per percorso: il pacchetto non
 * è una dipendenza del server.
 */
const TOOLS = join(import.meta.dirname, "../../../../packages/mcp/src/tools");
const FIXTURES = [
  { file: "lotto2.fixture.ts", name: "LOTTO2_CATALOG" },
  { file: "lotto3.fixture.ts", name: "LOTTO3_CATALOG" },
  { file: "lotto4.fixture.ts", name: "LOTTO4_CATALOG" },
];

type Entry = Omit<CatalogEntry, "instancePermission">;

async function serverEntries(): Promise<Entry[]> {
  const collector = createRouteCollector();
  const app = buildApp({ onRoute: collector.hook });
  await app.ready();
  await app.close();
  return catalogEntries(collector.routes()).map((e) => {
    const copy: Entry & { instancePermission?: string } = { ...e };
    delete copy.instancePermission;
    return copy;
  });
}

const byAction = (list: { action: string }[]) => [...list].sort((a, b) => a.action.localeCompare(b.action));

describe("le fixture dei lotti del pacchetto MCP", () => {
  it.each(FIXTURES)("$file coincide con le voci del catalogo del server, campo per campo", async ({ file, name }) => {
    const mod = (await import(pathToFileURL(join(TOOLS, file)).href)) as Record<string, Entry[]>;
    const fixture = mod[name]!;
    const wanted = new Set(fixture.map((e) => e.action));
    const server = (await serverEntries()).filter((e) => wanted.has(e.action));
    expect(server.map((e) => e.action).sort()).toEqual([...wanted].sort());
    expect(byAction(fixture)).toEqual(byAction(server));
  });
});
