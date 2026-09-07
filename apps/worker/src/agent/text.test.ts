import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeAgentRunner } from "./fake.js";
import { capText, outputOrThrow, parseAgentJson, runAgentText } from "./text.js";

/**
 * Helper condivisi dei run "di solo testo" dell'agente (report giornaliero,
 * intake/estimate del backlog, riassunti della fase 5). I test coprono il
 * contratto che i tre adottanti davano per scontato quando ognuno aveva la
 * propria copia: exit ≠ 0 → nessun testo, output vuoto → nessun testo, parse
 * JSON difensivo, troncamento marcato.
 */

describe("runAgentText", () => {
  it("exit 0 con output → il testo trimmato", async () => {
    const runner = new FakeAgentRunner({ output: "  Riassunto del piano.\n" });

    const text = await runAgentText(runner, {
      prompt: "riassumi",
      cwd: "/tmp",
      timeoutMs: 1000,
    });

    expect(text).toBe("Riassunto del piano.");
  });

  it("exit ≠ 0 → null (nessun testo da un run crashato)", async () => {
    const runner = new FakeAgentRunner({ output: "output parziale", exitCode: 1 });

    const text = await runAgentText(runner, {
      prompt: "riassumi",
      cwd: "/tmp",
      timeoutMs: 1000,
    });

    expect(text).toBeNull();
  });

  it("output vuoto → null", async () => {
    const runner = new FakeAgentRunner({ output: "   \n  " });

    const text = await runAgentText(runner, {
      prompt: "riassumi",
      cwd: "/tmp",
      timeoutMs: 1000,
    });

    expect(text).toBeNull();
  });

  it("permissionMode 'plan' e maxTurns 3 di default", async () => {
    const runner = new FakeAgentRunner({ output: "ok" });

    await runAgentText(runner, { prompt: "riassumi", cwd: "/tmp", timeoutMs: 1000 });

    expect(runner.calls[0]!.permissionMode).toBe("plan");
    expect(runner.calls[0]!.maxTurns).toBe(3);
  });

  it("model e provider passati solo quando presenti", async () => {
    const runner = new FakeAgentRunner({ output: "ok" });

    await runAgentText(runner, { prompt: "p", cwd: "/tmp", timeoutMs: 1000 });
    await runAgentText(runner, {
      prompt: "p",
      cwd: "/tmp",
      timeoutMs: 1000,
      model: "haiku",
      maxTurns: 5,
    });

    expect("model" in runner.calls[0]!).toBe(false);
    expect("provider" in runner.calls[0]!).toBe(false);
    expect(runner.calls[1]!.model).toBe("haiku");
    expect(runner.calls[1]!.maxTurns).toBe(5);
  });

  it("cwd assente → dir temporanea usata per il run e rimossa alla fine", async () => {
    const runner = new FakeAgentRunner({ output: "ok" });

    const text = await runAgentText(runner, { prompt: "riassumi", timeoutMs: 1000 });

    expect(text).toBe("ok");
    const usedCwd = runner.calls[0]!.cwd;
    expect(usedCwd).toBeTruthy();
    expect(usedCwd).not.toBe("/tmp");
    expect(existsSync(usedCwd)).toBe(false);
  });

  it("cwd assente → la dir temporanea è rimossa anche se il run lancia", async () => {
    let seenCwd = "";
    const runner = new FakeAgentRunner({
      script: (opts) => {
        seenCwd = opts.cwd;
        throw new Error("boom");
      },
    });

    await expect(
      runAgentText(runner, { prompt: "riassumi", timeoutMs: 1000 }),
    ).rejects.toThrow(/boom/);
    expect(seenCwd).toBeTruthy();
    expect(existsSync(seenCwd)).toBe(false);
  });
});

describe("parseAgentJson", () => {
  const schema = z.object({ title: z.string(), n: z.number() });

  it("estrae l'oggetto da un fence ```json", () => {
    const parsed = parseAgentJson(schema, '```json\n{"title":"a","n":1}\n```');
    expect(parsed).toEqual({ title: "a", n: 1 });
  });

  it("estrae l'oggetto con preambolo e postambolo attorno", () => {
    const parsed = parseAgentJson(schema, 'Ecco:\n{"title":"a","n":1}\nFine.');
    expect(parsed).toEqual({ title: "a", n: 1 });
  });

  it("JSON invalido → null", () => {
    expect(parseAgentJson(schema, "non è json")).toBeNull();
  });

  it("JSON valido ma non conforme allo schema → null", () => {
    expect(parseAgentJson(schema, '{"title":"a"}')).toBeNull();
  });
});

describe("capText", () => {
  it("testo sotto il tetto → invariato, nessun marcatore", () => {
    expect(capText("riga1\nriga2", 100, "[troncato]")).toBe("riga1\nriga2");
  });

  it("testo sopra il tetto → troncato con marcatore, senza spezzare una riga", () => {
    const text = ["riga uno", "riga due", "riga tre"].join("\n");

    const capped = capText(text, 20, "[troncato]");

    expect(capped).toContain("[troncato]");
    expect(capped).not.toContain("riga tre");
    // Nessuna riga tagliata a metà: ogni riga presente lo è per intero.
    for (const line of capped.split("\n")) {
      if (line === "" || line === "[troncato]") continue;
      expect(text.split("\n")).toContain(line);
    }
  });

  it("prima riga più lunga del tetto → tenuta comunque, col marcatore", () => {
    const text = "una riga molto molto lunga\nseconda";

    const capped = capText(text, 5, "[troncato]");

    expect(capped).toContain("una riga molto molto lunga");
    expect(capped).toContain("[troncato]");
    expect(capped).not.toContain("seconda");
  });
});

describe("outputOrThrow", () => {
  it("exit 0 → l'output grezzo", () => {
    expect(outputOrThrow({ output: " {\"a\":1} ", exitCode: 0 }, "intake")).toBe(' {"a":1} ');
  });

  it("exit ≠ 0 → lancia con etichetta ed exit code", () => {
    expect(() => outputOrThrow({ output: "x", exitCode: 1 }, "intake (merge)")).toThrow(
      /intake \(merge\).*exit 1/,
    );
  });
});
