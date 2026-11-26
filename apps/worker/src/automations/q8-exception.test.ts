import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * L'ECCEZIONE Q8 (area 7, F3): un'automazione PUÒ avviare un passo di Claude
 * senza un umano — è l'UNICA eccezione all'invariante delle serie («una serie
 * ricorrente non avvia MAI lavoro», `docs/invariants/mail-calendar.md`). Due
 * controlli sul sorgente, perché nessun altro percorso automatico la prenda:
 * - il passo di Claude (`claude-step.ts`) lo chiama solo l'esecutore delle
 *   automazioni, dove passa dal budget di OGNI passo;
 * - il percorso automatico delle serie (`calendar-auto.ts`) non nomina nessun
 *   esecutore di agenti.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

function files(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(files(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("l'eccezione Q8 resta una sola", () => {
  it("il passo di Claude lo importa SOLO l'esecutore delle automazioni", () => {
    const importers = files(SRC)
      .filter((f) => /from "\.{1,2}\/(automations\/)?claude-step\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(importers).toEqual(["automations/executor.ts"]);
  });

  it("il percorso automatico delle serie del calendario non nomina nessun esecutore di agenti", () => {
    const src = readFileSync(join(SRC, "google/calendar-auto.ts"), "utf8");
    for (const forbidden of ["AgentRunner", "TrackingAgentRunner", "runAgentText", "runClaudeStep", "claude-step", "../agent/", "./automations/"]) {
      expect(src.includes(forbidden), forbidden).toBe(false);
    }
  });
});
