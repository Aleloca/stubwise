import { describe, expect, it } from "vitest";
import { readerSchema } from "../reader.js";
import { whoCanResponseSchema } from "./access-query.js";

describe("whoCanResponseSchema (area 9, F1)", () => {
  it("una risposta SENZA `agent` (server più vecchio) dà il fatto fisso di default; un motivo ignoto è UNKNOWN", () => {
    const parsed = readerSchema(whoCanResponseSchema).parse({
      permission: "runs.start",
      projectId: null,
      people: [{ userId: "40000000-0000-4000-8000-000000000001", email: "a@acme.com", reasons: [{ kind: "nuovo_motivo" }] }],
    });
    expect(parsed.agent).toEqual({ actsFor: "confirmer" });
    expect(parsed.people[0]!.reasons[0]!.kind).toBe("__unknown__");
    expect(parsed.people[0]!.displayName).toBeNull();
  });
});
