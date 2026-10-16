import { describe, expect, it } from "vitest";
import type { AgentRunner, AgentRunResult } from "../agent/runner.js";
import { costRecordingRunner, formatOnceReport, parseOnceArgs } from "./once.js";
import type { NightResult } from "./types.js";

const ID = "0b4e6c1e-6a39-4d0b-9a59-1b8e2b7f0c11";

describe("parseOnceArgs", () => {
  it("legge --repository, anche dopo il `--` di pnpm e nella forma con `=`", () => {
    expect(parseOnceArgs(["--", "--repository", ID])).toEqual({ repositoryId: ID });
    expect(parseOnceArgs([`--repository=${ID}`])).toEqual({ repositoryId: ID });
  });

  it("senza id, con un id che non è un uuid o con argomenti sconosciuti → errore d'uso", () => {
    expect(() => parseOnceArgs([])).toThrow(/--repository/);
    expect(() => parseOnceArgs(["--repository", "acme"])).toThrow(/--repository/);
    expect(() => parseOnceArgs(["--repository", ID, "--all"])).toThrow(/sconosciuto/);
  });
});

describe("costRecordingRunner", () => {
  it("somma il costo dei run per modello e restituisce il risultato invariato", async () => {
    const costs = [0.01, 0.2, 0.03];
    let i = 0;
    const inner: AgentRunner = {
      run: async () =>
        ({ exitCode: 0, output: "ok", usage: { totalCostUsd: costs[i++] } }) as unknown as AgentRunResult,
    };
    const { runner, byModel } = costRecordingRunner(inner);
    const r = await runner.run({ prompt: "a", cwd: "/tmp", model: "haiku", timeoutMs: 1 } as never);
    await runner.run({ prompt: "b", cwd: "/tmp", model: "sonnet", timeoutMs: 1 } as never);
    await runner.run({ prompt: "c", cwd: "/tmp", model: "haiku", timeoutMs: 1 } as never);
    expect(r.output).toBe("ok");
    const totals = byModel();
    expect(totals.get("haiku")?.runs).toBe(2);
    expect(totals.get("haiku")?.costUsd).toBeCloseTo(0.04);
    expect(totals.get("sonnet")).toEqual({ runs: 1, costUsd: 0.2 });
  });

  it("un run senza usage conta zero dollari ma conta il run", async () => {
    const inner: AgentRunner = { run: async () => ({ exitCode: 1 }) as unknown as AgentRunResult };
    const { runner, byModel } = costRecordingRunner(inner);
    await runner.run({ prompt: "a", cwd: "/tmp", timeoutMs: 1 } as never);
    expect(byModel().get("(default)")).toEqual({ runs: 1, costUsd: 0 });
  });
});

describe("formatOnceReport", () => {
  const result: NightResult = {
    night: "2026-10-16",
    repositories: 1,
    itemsDone: 5,
    itemsPending: 0,
    stoppedForQuota: false,
    skipped: [],
  };

  it("stampa il NightResult, il costo per modello col totale e i riassunti", () => {
    const text = formatOnceReport(
      result,
      new Map([
        ["sonnet", { runs: 3, costUsd: 1.5 }],
        ["haiku", { runs: 4, costUsd: 0.04 }],
      ]),
      [
        { model: "haiku", count: 4, costUsd: 0.04 },
        { model: null, count: 1, costUsd: 0 },
      ],
    );
    expect(text).toContain('"itemsDone": 5');
    expect(text).toContain("haiku: 4 run, $0.0400");
    expect(text).toContain("sonnet: 3 run, $1.5000");
    expect(text).toContain("totale: $1.5400");
    expect(text).toContain("deterministico (rumore): 1");
    expect(text).not.toContain("Nessun repository");
  });

  it("un giro senza repository lo dice (interruttori spenti o id sbagliato)", () => {
    const text = formatOnceReport({ ...result, repositories: 0, itemsDone: 0 }, new Map(), []);
    expect(text).toContain("Nessun repository nel giro");
    expect(text).toContain("totale: $0.0000");
  });
});
