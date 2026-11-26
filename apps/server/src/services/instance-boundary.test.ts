import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Area 9, F4: il confine, per costruzione (CLAUDE.md, «Stubwise non fa
 * deploy: il merge è il confine»). Lo Stato dell'istanza, la pausa e il
 * rilancio agiscono SOLO sulla coda di Stubwise: nessun modulo di F4 parla con
 * un server (comandi firmati, SSH, il bridge degli agenti), lancia un
 * processo o tocca docker, e nessuno annulla o ferma un lavoro partito.
 */
const root = join(import.meta.dirname, "..");
const F4_MODULES = ["services/instance-status.ts", "services/project-queue.ts", "services/usage-summary.ts", "routes/instance-status.ts", "routes/project-queue.ts"];
const FORBIDDEN = [/server-ops/, /serverCommands|server_commands/, /issueServerCommand|signCommand/, /\bssh\b/i, /docker/i, /child_process|execa|spawn\(/, /cancelRequestedAt|cancel_requested_at/];

describe("il confine dello Stato dell'istanza", () => {
  it("nessun modulo di F4 parla coi server, lancia processi o annulla un lavoro", () => {
    for (const file of F4_MODULES) {
      const source = readFileSync(join(root, file), "utf8");
      for (const pattern of FORBIDDEN) expect(source, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("il controllo prende davvero un modulo che lo facesse", () => {
    expect(FORBIDDEN.some((p) => p.test('import { issueServerCommand } from "@stubwise/notifications";'))).toBe(true);
    expect(FORBIDDEN.some((p) => p.test("await db.update(aiJobs).set({ cancelRequestedAt: new Date() })"))).toBe(true);
  });
});
