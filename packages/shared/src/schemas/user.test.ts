import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { sessionResponseSchema } from "./user.js";

/**
 * `GET /api/auth/me` verso un server più vecchio (22 ott 2026): senza i
 * permessi granulari la risposta non porta `instancePermissions` né
 * `projectPermissions`. L'app li legge vuoti — nessun permesso — e il parse
 * della sessione, che regge l'intera app, non salta.
 */
const utente = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ada@example.com",
  role: "member",
  language: "it",
  avatarUrl: null,
  slackUserId: null,
};

describe("sessionResponseSchema: permessi verso un server più vecchio", () => {
  it("una risposta senza i campi dei permessi si legge con i default vuoti", () => {
    const parsed = readerSchema(sessionResponseSchema).parse({ user: utente }) as {
      instancePermissions: string[];
      projectPermissions: Record<string, string[]>;
    };
    expect(parsed.instancePermissions).toEqual([]);
    expect(parsed.projectPermissions).toEqual({});
  });

  it("quando ci sono, si leggono verbatim", () => {
    const parsed = sessionResponseSchema.parse({
      user: utente,
      instancePermissions: ["projects.create"],
      projectPermissions: { "22222222-2222-4222-8222-222222222222": ["tickets.create"] },
    });
    expect(parsed.instancePermissions).toEqual(["projects.create"]);
    expect(parsed.projectPermissions["22222222-2222-4222-8222-222222222222"]).toEqual([
      "tickets.create",
    ]);
  });
});
