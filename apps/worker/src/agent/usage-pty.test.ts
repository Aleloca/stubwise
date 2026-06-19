import { describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  captureUsageOutput,
  stripAnsi,
  type FakePty,
  type PtySpawner,
} from "./usage-pty.js";

const account: ResolvedProvider = { id: "p1", kind: "account", secret: "oauth-secret-xyz" };

/**
 * Mini-fake di uno pseudo-terminale: registra i dati scritti, espone helper per
 * emettere output verso il consumatore e per simulare l'uscita del processo.
 */
function makeFakePty(): { pty: FakePty; emit: (s: string) => void; exit: (code: number) => void } {
  let dataCb: ((d: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const writes: string[] = [];
  const pty: FakePty = {
    writes,
    killed: false,
    onData(cb) {
      dataCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    write(d) {
      writes.push(d);
    },
    kill() {
      pty.killed = true;
    },
  };
  return {
    pty,
    emit: (s) => dataCb?.(s),
    exit: (code) => exitCb?.({ exitCode: code }),
  };
}

describe("stripAnsi", () => {
  it("rimuove le sequenze di escape ANSI lasciando il testo", () => {
    const colored = "[1m[32m42% used[0m\r\n[2KResets in 2h";
    expect(stripAnsi(colored)).toBe("42% used\r\nResets in 2h");
  });
});

describe("captureUsageOutput", () => {
  it("inietta CLAUDE_CODE_OAUTH_TOKEN per un account, invia /usage e cattura l'output ripulito", async () => {
    const fake = makeFakePty();
    let spawnedEnv: Record<string, string> = {};
    const spawner: PtySpawner = (_file, _args, opts) => {
      spawnedEnv = opts.env;
      // Simula: TUI pronta, poi (dopo /usage) il render dell'usage.
      queueMicrotask(() => {
        fake.emit("[2J Welcome to Claude Code [0m\n> ");
        // Dopo che il chiamante ha inviato /usage, emette il pannello.
        setTimeout(() => {
          fake.emit("[1m42% used[0m\r\nWeekly 31% used\r\n");
          fake.exit(0);
        }, 5);
      });
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 1,
      renderDelayMs: 8,
      timeoutMs: 1000,
    });

    // L'env iniettato usa la var dell'account, NON l'API key.
    expect(spawnedEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-secret-xyz");
    expect(spawnedEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
    // È stato inviato il comando /usage seguito da invio.
    expect(fake.pty.writes.join("")).toContain("/usage");
    // L'output catturato è ripulito dagli ANSI.
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
    expect(out).not.toContain("[");
  });

  it("uccide il processo e ritorna l'output parziale al timeout (best-effort, mai lancia)", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => fake.emit("output parziale prima del blocco"));
      // Non chiama mai exit → forza il timeout.
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 1,
      renderDelayMs: 1,
      timeoutMs: 20,
    });

    expect(out).toContain("output parziale");
    expect(fake.pty.killed).toBe(true);
  });

  it("non lancia se lo spawner stesso fallisce: ritorna stringa vuota", async () => {
    const spawner: PtySpawner = () => {
      throw new Error("posix_spawnp failed");
    };
    const out = await captureUsageOutput(account, { spawner, timeoutMs: 50 });
    expect(out).toBe("");
  });

  it("default spawner: non spawna claude reale nei test (lo spawner è iniettabile)", () => {
    // Solo a documentare l'intento: i test passano sempre uno spawner fake.
    expect(typeof captureUsageOutput).toBe("function");
  });

  it("non logga MAI il segreto", async () => {
    const fake = makeFakePty();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        fake.emit("42% used\nWeekly 10% used");
        fake.exit(0);
      });
      return fake.pty;
    };
    await captureUsageOutput(account, { spawner, readyDelayMs: 1, renderDelayMs: 2, timeoutMs: 500 });
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("oauth-secret-xyz");
    spy.mockRestore();
  });
});
