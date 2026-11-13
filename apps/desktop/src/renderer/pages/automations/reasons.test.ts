import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import i18n from "../../i18n";
import en from "../../i18n/locales/en.json";
import it_ from "../../i18n/locales/it.json";
import { reasonWords } from "./format";

// B1: le motivazioni si mostrano dal codice, nella lingua di chi guarda —
// mai la prosa italiana del registro — e nella prova al condizionale.

const ROOT = join(__dirname, "../..");
const SOURCES = ["data/automations", "domain/automations", "data/seed/automations"];
/** I piani e le regole delle esecuzioni, spostati in shared perché li usi anche il worker. */
const SHARED_FILES = ["plans.ts", "runRules.ts"].map((f) =>
  join(ROOT, "../../../../packages/shared/src/automations", f),
);
/**
 * L'esecutore vero (area 7, build app): le motivazioni che scrive il worker
 * le mostra lo stesso renderer. `claude-step.ts` dà codici del PROVIDER
 * (`providerCodes`, un'altra famiglia di parole), non motivazioni.
 */
const WORKER_DIR = join(ROOT, "../../../worker/src/automations");
const WORKER_FILES = readdirSync(WORKER_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "claude-step.ts")
  .map((f) => join(WORKER_DIR, f));

/** I codici delle motivazioni scritti dal livello dati e dal motore. */
function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  const files = [
    ...SOURCES.flatMap((dir) =>
      readdirSync(join(ROOT, dir))
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(ROOT, dir, f)),
    ),
    ...SHARED_FILES,
    ...WORKER_FILES,
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // `{ code: "…" }` e `code: x ? "…" : "…"`; `limit` è un codice dei problemi del flusso.
    for (const m of src.matchAll(
      /code: (?:[\w.]+ \? )?"([a-z][a-zA-Z]+)"(?: : "([a-z][a-zA-Z]+)")?/g,
    )) {
      for (const c of [m[1], m[2]]) if (c && c !== "limit") codes.add(c);
    }
  }
  return codes;
}

describe("motivazioni (B1)", () => {
  it("ogni codice scritto ha la sua frase in inglese e in italiano", () => {
    const codes = emittedCodes();
    expect(codes.size).toBeGreaterThan(25);
    const enReasons = en.automations.reasons as Record<string, string>;
    const itReasons = it_.automations.reasons as Record<string, string>;
    for (const c of codes) {
      expect(enReasons[c], c).toBeTypeOf("string");
      expect(itReasons[c], c).toBeTypeOf("string");
    }
  });

  it("dal codice, nella lingua di chi guarda; nella prova al condizionale; il ruolo con la sua parola", async () => {
    const t = i18n.getFixedT("en");
    const why = { code: "noMailbox", params: { owner: "Matteo Conti" } };
    expect(reasonWords(why, t)).toBe(
      "The owner (Matteo Conti) has no connected mailbox: the email wasn't sent.",
    );
    expect(reasonWords(why, t, { would: true })).toBe(
      "The owner (Matteo Conti) has no connected mailbox: the email wouldn't be sent.",
    );
    // Senza una forma al condizionale vale quella di sempre.
    expect(reasonWords({ code: "badField" }, t, { would: true })).toBe(
      "Claude returned fields the step doesn't declare, or of the wrong kind.",
    );
    expect(
      reasonWords({ code: "noRoleHolder", params: { role: "project_lead" } }, t),
    ).not.toContain("project_lead");
    expect(reasonWords({ code: "nope" }, t)).toBe("Something went wrong.");
    expect(reasonWords(null, t)).toBeNull();
    expect(reasonWords(why, i18n.getFixedT("it"), { would: true })).toBe(
      "Il proprietario (Matteo Conti) non ha una casella collegata: l'email non partirebbe.",
    );
  });
});
