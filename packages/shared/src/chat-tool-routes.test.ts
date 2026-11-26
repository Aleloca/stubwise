import { describe, expect, it } from "vitest";
import { CHAT_TOOL_READ_ROUTES, chatRoutePattern } from "./chat-tool-routes.js";

describe("l'allowlist del token del turno, in un posto (area 8, F1)", () => {
  it("una rotta coi parametri combacia col percorso concreto, segmento per segmento", () => {
    const re = chatRoutePattern("/api/releases/:code");
    expect(re.test("/api/releases/AUD-V7")).toBe(true);
    expect(re.test("/api/releases/")).toBe(false);
    expect(re.test("/api/releases/AUD-V7/fix")).toBe(false);
    expect(chatRoutePattern("/api/projects").test("/api/projects/x")).toBe(false);
  });

  it("ci sono le letture dei tool di Claude, compresi pagina Docs e rilascio", () => {
    for (const route of ["/api/tasks/by-code/:code", "/api/repositories/:repositoryId/docs/pages/:slug", "/api/releases/:code"]) {
      expect(CHAT_TOOL_READ_ROUTES.has(route)).toBe(true);
    }
  });
});
