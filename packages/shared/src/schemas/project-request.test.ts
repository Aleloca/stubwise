import { describe, expect, it } from "vitest";
import { PROJECT_CODE_RE } from "../tasks/project-code.js";
import { backlogJobStatusSchema } from "./backlog.js";
import { projectCodeSchema } from "./project.js";
import { requestJobViewSchema } from "./project-request.js";

describe("schemi delle richieste (fetta 4)", () => {
  it("lo stato del job di una richiesta È quello dei job di backlog, non una copia che può divergere", () => {
    expect(requestJobViewSchema.shape.status).toBe(backlogJobStatusSchema);
  });

  it("le due regole del codice di progetto: ogni codice che la proposta dà passa la validazione del server", () => {
    for (const code of ["AB", "STW", "BRLX"]) {
      expect(PROJECT_CODE_RE.test(code)).toBe(true);
      expect(projectCodeSchema.safeParse(code).success).toBe(true);
    }
    // La validazione è più larga: i codici ricavati dagli slug di prima.
    for (const code of ["A1", "STW2", "ABCDEF"]) {
      expect(PROJECT_CODE_RE.test(code)).toBe(false);
      expect(projectCodeSchema.safeParse(code).success).toBe(true);
    }
  });
});
