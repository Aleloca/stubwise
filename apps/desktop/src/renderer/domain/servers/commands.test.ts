import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../data/model";
import { SERVER_CONVERSATIONS } from "../../data/seed/servers/analysis";
import { commandInput, inClosedSet, serverCommandsOf, truncateOutput } from "./commands";
import { COMMAND_OUTPUT_MAX_LINES } from "./limits";

// I comandi su un server sono SOLO quelli degli insiemi chiusi di
// `@stubwise/shared` (area 8, F4b): le azioni dell'agente (`SERVER_ACTIONS`)
// e le letture SSH (`SSH_READS`). Nessun comando libero.

const ssh = (action: string, params: Record<string, unknown> = {}) =>
  ({ action, params, kind: "read", via: "ssh", approvalId: null, exitCode: 0 }) as const;
const agent = (action: string, params: Record<string, unknown>, kind: "change" | "read") =>
  ({ action, params, kind, via: "agent", approvalId: null, exitCode: 0 }) as const;

describe("inClosedSet", () => {
  it("le letture SSH dell'elenco, coi parametri stretti", () => {
    expect(inClosedSet(ssh("disk"))).toBe(true);
    expect(inClosedSet(ssh("processes", { top: 10 }))).toBe(true);
    expect(inClosedSet(ssh("journal_errors", { lines: 50 }))).toBe(true);
    expect(inClosedSet(ssh("processes", { top: 999 }))).toBe(false);
    expect(inClosedSet(ssh("disk", { path: "/" }))).toBe(false);
    expect(inClosedSet(ssh("cat /etc/shadow"))).toBe(false);
    // Una lettura SSH non cambia mai niente.
    expect(inClosedSet({ ...ssh("disk"), kind: "change" })).toBe(false);
  });

  it("le azioni dell'agente, col tipo giusto", () => {
    expect(
      inClosedSet(agent("container.restart", { container: "api", timeoutSeconds: 30 }, "change")),
    ).toBe(true);
    expect(inClosedSet(agent("docker.prune", { what: "images_unused" }, "change"))).toBe(true);
    expect(
      inClosedSet(
        agent("container.logs", { container: "api", lines: 200, sinceMinutes: 30 }, "read"),
      ),
    ).toBe(true);
    // Il tipo dichiarato deve essere quello dell'azione.
    expect(
      inClosedSet(agent("container.restart", { container: "api", timeoutSeconds: 30 }, "read")),
    ).toBe(false);
    // Fuori dall'insieme, o con una stringa di shell nel nome del container.
    for (const action of ["image.pull", "container.exec", "compose.up", "container.create"])
      expect(inClosedSet(agent(action, { container: "api" }, "change")), action).toBe(false);
    expect(inClosedSet(agent("container.start", { container: "api; rm -rf /" }, "change"))).toBe(
      false,
    );
    expect(inClosedSet(agent("container.start", { container: "../etc" }, "change"))).toBe(false);
    // Le letture via agente non passano dall'SSH, e viceversa.
    expect(inClosedSet({ ...ssh("container.state", { container: "api" }) })).toBe(false);
    expect(inClosedSet(agent("disk", {}, "read"))).toBe(false);
  });

  it("ogni comando della sessione d'analisi del seme è nell'insieme chiuso, e la riga lo dice", () => {
    const actions = SERVER_CONVERSATIONS.flatMap((s) => s.events).filter(
      (e): e is Extract<ConversationEvent, { type: "action" }> => e.type === "action",
    );
    expect(actions.length).toBeGreaterThanOrEqual(5);
    for (const a of actions) {
      expect(a.serverCommand, a.label).toBeDefined();
      expect(inClosedSet(a.serverCommand!), a.label).toBe(true);
      expect(a.input).toBe(commandInput(a.serverCommand!));
    }
  });
});

describe("commandInput", () => {
  it("una lettura SSH: l'argv FISSO di shared", () => {
    expect(commandInput(ssh("disk"))).toBe("df -P");
    expect(commandInput(ssh("journal_errors", { lines: 50 }))).toBe(
      "journalctl -p err -n 50 --no-pager",
    );
  });

  it("un'azione dell'agente: il nome dell'azione e i parametri, mai una riga di shell", () => {
    expect(
      commandInput(agent("container.restart", { container: "api", timeoutSeconds: 30 }, "change")),
    ).toBe("container.restart container=api timeoutSeconds=30");
  });
});

describe("serverCommandsOf (i concetti di `serverCommandViewSchema`)", () => {
  it("una riga per comando su un server, con chi l'ha chiesto e l'approvazione", () => {
    const events: ConversationEvent[] = [
      { id: "s", at: "2026-11-14T10:00:00Z", type: "assistant", text: "hi", done: true },
      {
        id: "r1",
        at: "2026-11-14T10:01:00Z",
        type: "action",
        tool: "server.read",
        label: "read",
        input: "container.state container=api",
        result: "{}",
        state: "done",
        serverCommand: agent("container.state", { container: "api" }, "read"),
      },
      {
        id: "x1",
        at: "2026-11-14T10:02:00Z",
        type: "action",
        tool: "server.fix",
        label: "restart",
        input: "container.restart container=api timeoutSeconds=30",
        result: "[evil](http://x) restarted",
        state: "running",
        serverCommand: {
          ...agent("container.restart", { container: "api", timeoutSeconds: 30 }, "change"),
          approvalId: "plan-1",
          exitCode: null,
        },
      },
      {
        id: "a",
        at: "2026-11-14T10:03:00Z",
        type: "action",
        tool: "read",
        label: "x",
        state: "done",
      },
    ];
    expect(serverCommandsOf(events, "p-roberta")).toEqual([
      {
        id: "r1",
        action: "container.state",
        params: { container: "api" },
        kind: "read",
        via: "agent",
        status: "done",
        requestedById: "p-roberta",
        approvalId: null,
        issuedAt: "2026-11-14T10:01:00Z",
        exitCode: 0,
        output: "{}",
      },
      {
        id: "x1",
        action: "container.restart",
        params: { container: "api", timeoutSeconds: 30 },
        kind: "change",
        via: "agent",
        status: "delivered",
        requestedById: "p-roberta",
        approvalId: "plan-1",
        issuedAt: "2026-11-14T10:02:00Z",
        exitCode: null,
        // L'uscita resta testo non fidato: non si interpreta qui.
        output: "[evil](http://x) restarted",
      },
    ]);
  });
});

describe("truncateOutput", () => {
  it("5000 righe → le ultime 40, troncato", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = truncateOutput(text);
    expect(out.truncated).toBe(true);
    const lines = out.text.split("\n");
    expect(lines).toHaveLength(COMMAND_OUTPUT_MAX_LINES);
    expect(lines[0]).toBe("line 4961");
    expect(lines.at(-1)).toBe("line 5000");
  });

  it("un'uscita corta resta intera", () => {
    expect(truncateOutput("a\nb\n")).toEqual({ text: "a\nb\n", truncated: false });
    const forty = Array.from({ length: 40 }, () => "x").join("\n");
    expect(truncateOutput(forty)).toEqual({ text: forty, truncated: false });
  });
});
