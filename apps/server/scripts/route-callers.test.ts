import { describe, expect, it } from "vitest";
import { classifyRoutes } from "./route-callers.js";

// Lo script delle rotte contro i chiamanti (ritiro del web vecchio, D4): una
// rotta «senza chiamanti» si toglie. Il worker è un chiamante vero: la chat di
// Claude legge il server col token del turno (`apps/worker/src/claude-chat`,
// solo GET). Senza il worker fra le radici, `GET /api/projects/pulse` risultava
// da togliere, e toglierla avrebbe spento una lettura della chat (R2).
describe("route-callers: i chiamanti del worker", () => {
  it("GET /api/projects/pulse è usata: la chiama la chat di Claude nel worker", async () => {
    const rows = await classifyRoutes();
    const pulse = rows.find((r) => r.key === "GET /api/projects/pulse");
    expect(pulse, "la rotta esiste").toBeDefined();
    expect(pulse!.status).toBe("usata");
    expect(pulse!.literal.some((f) => f.startsWith("apps/worker/src/claude-chat/"))).toBe(true);
  }, 120_000);

  it("le letture della chat contano come GET, non come scritture", async () => {
    const rows = await classifyRoutes();
    // Lo stesso percorso con un altro verbo, se esiste, non diventa «usato» per la chat.
    const writes = rows.filter(
      (r) => r.method !== "GET" && r.status === "usata" && r.client.length === 0 && r.literal.every((f) => f.startsWith("apps/worker/src/claude-chat/")),
    );
    expect(writes.map((r) => r.key)).toEqual([]);
  }, 120_000);
});

// D10 (decisione del maintainer, 28 nov 2026): le rotte dei tool dedicati di
// Claude Code restano come superficie propria dell'MCP e lo dichiarano
// (`config.mcp.owner: "mcp"`, elenco chiuso in `src/mcp/mcp-owned.test.ts`).
// Lo script non le propone da togliere: hanno un gruppo loro.
describe("route-callers: le rotte dell'MCP per scelta", () => {
  it("una rotta con `owner: \"mcp\"` non è mai «senza chiamanti»", async () => {
    const rows = await classifyRoutes();
    const owned = rows.filter((r) => r.owner === "mcp");
    expect(owned.length).toBe(12);
    expect(owned.filter((r) => r.status === "senza chiamanti" || r.status === "dubbio").map((r) => r.key)).toEqual([]);
    expect(owned.filter((r) => r.status !== "usata").every((r) => r.status === "dell'MCP")).toBe(true);
  }, 120_000);
});
