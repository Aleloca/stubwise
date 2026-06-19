import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../providers/chain.js";
import {
  captureUsageOutput,
  ensureClaudeOnboardingConfig,
  resolveClaudeConfigPaths,
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
      // Simula: TUI pronta (prompt principale), poi (dopo /usage) il render.
      queueMicrotask(() => {
        fake.emit("[2J Welcome to Claude Code [0m\n? for shortcuts · ← for agents\n> ");
      });
      // Dopo che il chiamante ha inviato /usage, emette il pannello ed esce.
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("[1m42% used[0m\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 5);
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 1,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 1000,
      preConfig: false,
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
      settleDelayMs: 1,
      submitDelayMs: 1,
      pollMs: 1,
      renderDelayMs: 1,
      timeoutMs: 20,
      preConfig: false,
    });

    expect(out).toContain("output parziale");
    expect(fake.pty.killed).toBe(true);
  });

  it("non lancia se lo spawner stesso fallisce: ritorna stringa vuota", async () => {
    const spawner: PtySpawner = () => {
      throw new Error("posix_spawnp failed");
    };
    const out = await captureUsageOutput(account, { spawner, timeoutMs: 50, preConfig: false });
    expect(out).toBe("");
  });

  it("default spawner: non spawna claude reale nei test (lo spawner è iniettabile)", () => {
    // Solo a documentare l'intento: i test passano sempre uno spawner fake.
    expect(typeof captureUsageOutput).toBe("function");
  });

  it("supera il wizard del tema con un Invio, poi invia /usage e ritorna l'output (no wizard)", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        // 1) All'avvio compare il wizard del tema.
        fake.emit("Choose the text style that looks best...\n❯ 2. Dark mode ✔\n");
        // 2) Quando il chiamante invia un Invio (\r), passiamo al prompt; quando
        //    invia /usage, emettiamo il pannello.
      });
      // Reagisce a ciò che viene scritto sul PTY.
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d === "\r") {
          // Accettato il tema: ora siamo al prompt (niente più wizard).
          setTimeout(() => fake.emit("\n> "), 1);
        } else if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("Current session 42% used\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 1);
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 2000,
      preConfig: false,
    });

    // Ha inviato almeno un Invio per superare il wizard PRIMA di /usage:
    // l'indice del primo "\r" precede quello del "/usage\r".
    const enterIdx = fake.pty.writes.indexOf("\r");
    const usageIdx = fake.pty.writes.findIndex((w) => w.includes("/usage"));
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeLessThan(usageIdx);
    // L'output catturato contiene il pannello di /usage (il parser a valle ne
    // estrae i dati; il buffer PTY include anche il testo precedente, normale).
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
  });

  it("supera il trust dialog con un Invio, raggiunge il prompt pronto e invia /usage", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        // 1) All'avvio compare il trust dialog di Claude Code.
        fake.emit(
          "Accessing workspace: /app\nQuick safety check: Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n    2. No, exit\n",
        );
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d === "\r") {
          // Accettato il trust: ora la TUI è al prompt principale.
          setTimeout(() => fake.emit("\nWelcome back!\n? for shortcuts · ← for agents\n"), 1);
        } else if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("Current session 42% used\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 1);
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 2000,
      preConfig: false,
    });

    const enterIdx = fake.pty.writes.indexOf("\r");
    const usageIdx = fake.pty.writes.findIndex((w) => w.includes("/usage"));
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeLessThan(usageIdx);
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
  });

  it("prompt pronto immediato: invia /usage senza Invio superflui", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        // La TUI è subito al prompt principale (nessun wizard/trust).
        fake.emit("Welcome back!\n? for shortcuts · ← for agents\n");
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("Current session 42% used\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 1);
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 2000,
      preConfig: false,
    });

    // /usage è stato inviato e l'output catturato; nessun "\r" di navigazione
    // è stato necessario PRIMA di /usage (prompt già pronto). L'unico "\r" è
    // quello dell'invio diviso, che segue il comando "/usage".
    expect(fake.pty.writes.join("")).toContain("/usage");
    const usageIdx = fake.pty.writes.findIndex((w) => w.includes("/usage"));
    const enterBeforeUsage = fake.pty.writes.slice(0, usageIdx).indexOf("\r");
    expect(enterBeforeUsage).toBe(-1);
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
  });

  it("trust + tema in sequenza: due Invii prima di /usage, poi cattura il pannello", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      let enters = 0;
      queueMicrotask(() => {
        // 1) Prima il trust dialog.
        fake.emit(
          "Quick safety check: Is this a project you created or one you trust?\n  ❯ 1. Yes, I trust this folder\n",
        );
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d === "\r") {
          enters += 1;
          if (enters === 1) {
            // Dopo il primo Invio compare il wizard del tema.
            setTimeout(() => fake.emit("Choose the text style that looks best...\n❯ 2. Dark mode ✔\n"), 1);
          } else {
            // Dopo il secondo Invio la TUI è al prompt principale.
            setTimeout(() => fake.emit("\n? for shortcuts · ← for agents\n"), 1);
          }
        } else if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("Current session 42% used\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 1);
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 2000,
      preConfig: false,
    });

    const usageIdx = fake.pty.writes.findIndex((w) => w.includes("/usage"));
    const entersBeforeUsage = fake.pty.writes
      .slice(0, usageIdx)
      .filter((w) => w === "\r").length;
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(entersBeforeUsage).toBeGreaterThanOrEqual(2);
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
  });

  it("nessun marcatore riconosciuto: dopo il cap invia /usage comunque (fallback) entro il limite", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        // Solo rumore: né login, né prompt pronto, né trust, né tema. Il loop
        // deve esaurire i passi di attesa e poi inviare /usage come fallback.
        fake.emit("…\n[caricamento]\nqualcosa di non riconosciuto\n");
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          setTimeout(() => {
            fake.emit("Current session 42% used\r\nWeekly 31% used\r\n");
            fake.exit(0);
          }, 1);
        }
      };
      return fake.pty;
    };

    const start = Date.now();
    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 5000,
      preConfig: false,
    });
    const elapsed = Date.now() - start;

    // /usage è stato inviato comunque (fallback dopo il cap), e ben prima del
    // timeout: budget di navigazione (~750ms) + render, non 5s.
    expect(fake.pty.writes.join("")).toContain("/usage");
    expect(out).toContain("42% used");
    expect(out).toContain("Weekly 31% used");
    expect(elapsed).toBeLessThan(2000);
  });

  it("su 'Select login method' (non autenticato) non resta bloccato e ritorna entro il limite", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        fake.emit("Select login method:\n❯ 1. Claude account with subscription\n");
      });
      // Non chiama mai exit di suo: se restasse bloccato, scatterebbe il timeout.
      return fake.pty;
    };

    const start = Date.now();
    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 20,
      timeoutMs: 5000,
      preConfig: false,
    });
    const elapsed = Date.now() - start;

    // È uscito ben prima del timeout (niente hang): ready + render, non 5s.
    expect(elapsed).toBeLessThan(1000);
    // Ha catturato l'output (per la diagnosi a valle) e ucciso il processo.
    expect(out).toContain("Select login method");
    expect(fake.pty.killed).toBe(true);
  });

  it("input pronto solo dopo un attimo: con il settle delay /usage arriva quando la TUI è interattiva e cattura il pannello", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      let interactive = false;
      queueMicrotask(() => {
        // Prompt principale visibile, ma l'input NON è ancora interattivo:
        // /usage scritto troppo presto viene SCARTATO.
        fake.emit("Welcome back!\n? for shortcuts · ← for agents\n");
        // Diventa interattiva solo dopo un attimo (animazione iniziale).
        setTimeout(() => {
          interactive = true;
        }, 30);
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage") && interactive) {
          setTimeout(() => {
            fake.emit("Current session\n12% used\r\nResets 3:00am\r\n");
            fake.exit(0);
          }, 1);
        }
        // /usage scritto prima dell'interattività: ignorato (nessun pannello).
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 60,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 400,
      timeoutMs: 3000,
      preConfig: false,
    });

    // Il pannello è stato catturato → /usage è stato accettato (settle ha
    // atteso che la TUI fosse interattiva) e il finish è scattato sul marker.
    expect(out).toContain("Current session");
    expect(out).toContain("12% used");
    expect(out).toContain("Resets");
    expect(fake.pty.writes.join("")).toContain("/usage");
  });

  it("early-exit: appena compare il pannello finisce, ben prima del tetto renderDelayMs", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        fake.emit("Welcome back!\n? for shortcuts · ← for agents\n");
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          // Il pannello compare quasi subito, ma NON facciamo exit: il finish
          // deve scattare sul MARKER, non sull'uscita del processo.
          setTimeout(() => {
            fake.emit("Current session\n12% used\r\nResets 3:00am\r\n");
          }, 1);
        }
      };
      return fake.pty;
    };

    const start = Date.now();
    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 4000,
      timeoutMs: 8000,
      preConfig: false,
    });
    const elapsed = Date.now() - start;

    expect(out).toContain("Current session");
    expect(out).toContain("12% used");
    // Finito sul marker, MOLTO prima del tetto (4s) e del timeout (8s).
    expect(elapsed).toBeLessThan(1500);
  });

  it("retry: ignora il PRIMO /usage, risponde al SECONDO; /usage scritto ≥2 volte e pannello catturato", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      let usageCount = 0;
      queueMicrotask(() => {
        fake.emit("Welcome back!\n? for shortcuts · ← for agents\n");
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          usageCount += 1;
          if (usageCount >= 2) {
            setTimeout(() => {
              fake.emit("Current session\n12% used\r\nResets 3:00am\r\n");
              fake.exit(0);
            }, 1);
          }
          // Il primo invio viene ignorato: nessun pannello.
        }
      };
      return fake.pty;
    };

    const out = await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 200,
      timeoutMs: 3000,
      preConfig: false,
    });

    const usageWrites = fake.pty.writes.filter((w) => w.includes("/usage")).length;
    expect(usageWrites).toBeGreaterThanOrEqual(2);
    expect(out).toContain("Current session");
    expect(out).toContain("12% used");
  });

  it("invio diviso: scrive '/usage' e, separatamente, '\\r' (il submit non è incollato al comando)", async () => {
    const fake = makeFakePty();
    const spawner: PtySpawner = () => {
      queueMicrotask(() => {
        fake.emit("Welcome back!\n? for shortcuts · ← for agents\n");
      });
      const origWrite = fake.pty.write.bind(fake.pty);
      fake.pty.write = (d: string): void => {
        origWrite(d);
        if (d.includes("/usage")) {
          // Emette il pannello DOPO che il submit "\r" diviso è stato scritto
          // (submitDelayMs=5): evita la race in cui l'exit cancella il timer
          // del "\r" prima che venga inviato.
          setTimeout(() => {
            fake.emit("Current session\n12% used\r\nResets 3:00am\r\n");
            fake.exit(0);
          }, 40);
        }
      };
      return fake.pty;
    };

    await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 5,
      settleDelayMs: 5,
      submitDelayMs: 5,
      pollMs: 5,
      renderDelayMs: 400,
      timeoutMs: 3000,
      preConfig: false,
    });

    // Il comando "/usage" è scritto da solo (senza \r incollato) e l'invio "\r"
    // è una write separata e SUCCESSIVA.
    const usageIdx = fake.pty.writes.findIndex((w) => w === "/usage");
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    const enterAfter = fake.pty.writes.slice(usageIdx + 1).indexOf("\r");
    expect(enterAfter).toBeGreaterThanOrEqual(0);
    // Non deve esistere una write "/usage\r" tutta attaccata.
    expect(fake.pty.writes).not.toContain("/usage\r");
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
    await captureUsageOutput(account, {
      spawner,
      readyDelayMs: 1,
      settleDelayMs: 2,
      submitDelayMs: 2,
      pollMs: 2,
      renderDelayMs: 5,
      timeoutMs: 500,
      preConfig: false,
    });
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("oauth-secret-xyz");
    spy.mockRestore();
  });
});

describe("resolveClaudeConfigPaths", () => {
  it("usa CLAUDE_CONFIG_DIR quando impostata", () => {
    const { dir, file } = resolveClaudeConfigPaths({ CLAUDE_CONFIG_DIR: "/home/worker/.claude" });
    expect(dir).toBe("/home/worker/.claude");
    expect(file).toBe(join("/home/worker/.claude", ".claude.json"));
  });

  it("ricade su ${HOME}/.claude quando CLAUDE_CONFIG_DIR manca", () => {
    const { dir, file } = resolveClaudeConfigPaths({ HOME: "/home/alice" });
    expect(dir).toBe(join("/home/alice", ".claude"));
    expect(file).toBe(join("/home/alice", ".claude", ".claude.json"));
  });
});

describe("ensureClaudeOnboardingConfig", () => {
  it("crea il file con le chiavi di skip-onboarding se assente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stubwise-claude-cfg-"));
    try {
      await ensureClaudeOnboardingConfig({ CLAUDE_CONFIG_DIR: dir });
      const raw = await readFile(join(dir, ".claude.json"), "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      expect(cfg["hasCompletedOnboarding"]).toBe(true);
      expect(cfg["hasViewedOnboarding"]).toBe(true);
      expect(cfg["theme"]).toBe("dark");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("è idempotente: non sovrascrive i valori già presenti e conserva le altre chiavi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stubwise-claude-cfg-"));
    try {
      const file = join(dir, ".claude.json");
      // L'utente ha già scelto il tema chiaro e ha altre impostazioni.
      await writeFile(
        file,
        JSON.stringify({ theme: "light", numStartups: 7 }),
        "utf8",
      );

      await ensureClaudeOnboardingConfig({ CLAUDE_CONFIG_DIR: dir });

      const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      // Valore esistente NON sovrascritto.
      expect(cfg["theme"]).toBe("light");
      // Altre chiavi preservate.
      expect(cfg["numStartups"]).toBe(7);
      // Chiavi mancanti aggiunte.
      expect(cfg["hasCompletedOnboarding"]).toBe(true);
      expect(cfg["hasViewedOnboarding"]).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("non scrive (e non lancia) se tutte le chiavi sono già presenti", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stubwise-claude-cfg-"));
    try {
      const file = join(dir, ".claude.json");
      const initial = {
        hasCompletedOnboarding: true,
        hasViewedOnboarding: true,
        theme: "dark",
      };
      await writeFile(file, JSON.stringify(initial), "utf8");

      await ensureClaudeOnboardingConfig({ CLAUDE_CONFIG_DIR: dir });

      // Contenuto invariato (nessuna riscrittura non necessaria).
      const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(cfg).toEqual(initial);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("non lancia su JSON corrotto: lo tratta come vuoto e scrive le chiavi", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stubwise-claude-cfg-"));
    try {
      const file = join(dir, ".claude.json");
      await writeFile(file, "{ not valid json", "utf8");

      await expect(ensureClaudeOnboardingConfig({ CLAUDE_CONFIG_DIR: dir })).resolves.toBeUndefined();

      const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      expect(cfg["hasCompletedOnboarding"]).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
