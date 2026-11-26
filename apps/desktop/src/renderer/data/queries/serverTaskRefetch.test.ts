import { describe, expect, it } from "vitest";
import { serverTaskRefetch } from "./servers";

// Review F4b I3: nell'app la sezione Server della task si rilegge mentre la
// correzione pianifica o gira (l'esecuzione non passa da una sessione), mai
// a riposo.

describe("la rilettura della sezione Server", () => {
  it("ogni 4 s mentre pianifica o gira, mai negli altri stati", () => {
    expect(serverTaskRefetch("fix_planning")).toBe(4000);
    expect(serverTaskRefetch("fixing")).toBe(4000);
    for (const s of ["diagnosis_ready", "plan_awaiting", "resolved", "stopped", undefined])
      expect(serverTaskRefetch(s), String(s)).toBe(false);
  });
});
