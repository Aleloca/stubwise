import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalCommandPayload, type ServerCommandPayload } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { dockerCallFor, executeAction, type DockerCall } from "./execute.js";
import { operationsTick } from "./loop.js";
import { verifyCommand, type NonceStore } from "./verify.js";

// Area 8, F4b, S4: the agent runs ONLY signed commands of the closed set. A
// fake Docker socket counts the calls: every refusal must leave it at ZERO.

const pair = generateKeyPairSync("ed25519");
const PUBLIC = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const other = generateKeyPairSync("ed25519");
const SERVER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-14T10:05:00.000Z");

function signed(over: Partial<ServerCommandPayload> = {}, key = pair.privateKey) {
  const payload: ServerCommandPayload = {
    v: 1,
    serverId: SERVER,
    commandId: `22222222-2222-4222-8222-${Math.floor(Math.random() * 1e12).toString().padStart(12, "0")}`,
    action: "container.restart",
    params: { container: "web", timeoutSeconds: 10 },
    approvalId: "33333333-3333-4333-8333-333333333333",
    issuedAt: "2026-11-14T10:00:00.000Z",
    expiresAt: "2026-11-14T10:10:00.000Z",
    ...over,
  };
  return { payload, signature: sign(null, Buffer.from(canonicalCommandPayload(payload)), key).toString("base64") };
}
const memoryNonces = (): NonceStore => {
  const s = new Map<string, string>();
  return { has: (id) => s.has(id), add: (id, e) => void s.set(id, e) };
};
const ctx = (nonces = memoryNonces()) => ({ publicKey: PUBLIC, serverId: SERVER, now: NOW, nonces, seenContainers: ["web", "db"] });

/** A fake server + a fake Docker socket that counts calls. */
function harness(command: unknown) {
  const calls: DockerCall[] = [];
  const reports: { url: string; body: unknown }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/monitor/commands")) return new Response(JSON.stringify({ command }), { status: 200 });
    reports.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const docker = async (call: DockerCall) => {
    calls.push(call);
    return { statusCode: 204, body: "" };
  };
  return { calls, reports, fetchFn, docker };
}
const tick = (h: ReturnType<typeof harness>, nonces = memoryNonces(), serverId: string | null = SERVER) =>
  operationsTick({ baseUrl: "https://s.example", serverKey: "sk_x", publicKey: PUBLIC, nonces, docker: h.docker, seenContainers: () => ["web", "db"], serverId: () => serverId, fetchFn: h.fetchFn, now: () => NOW });

describe("verifyCommand", () => {
  it("a valid command: ok, and its nonce is spent (a replay is refused)", () => {
    const nonces = memoryNonces();
    const cmd = signed();
    expect(verifyCommand(cmd, ctx(nonces))).toMatchObject({ ok: true });
    expect(verifyCommand(cmd, ctx(nonces))).toMatchObject({ ok: false, reason: "replayed" });
  });

  it("NEGATIVE: forged, other key, changed payload, other server, expired, unknown action, bad params, unseen container", () => {
    const good = signed();
    const cases: [unknown, string][] = [
      [{ ...good, signature: Buffer.from("nope").toString("base64") }, "bad_signature"],
      [signed({}, other.privateKey), "bad_signature"],
      [{ ...good, payload: { ...good.payload, params: { container: "db", timeoutSeconds: 10 } } }, "bad_signature"],
      [{ ...good, payload: { ...good.payload, action: "container.stop" } }, "bad_signature"],
      [signed({ serverId: "44444444-4444-4444-8444-444444444444" }), "other_server"],
      [signed({ expiresAt: "2026-11-14T10:00:01.000Z" }), "expired"],
      [signed({ action: "container.exec", params: { container: "web", cmd: "sh" } }), "bad_action"],
      [signed({ action: "image.pull", params: { image: "evil:latest" } }), "bad_action"],
      [signed({ params: { container: "web; rm -rf /", timeoutSeconds: 10 } }), "bad_action"],
      [signed({ params: { container: "web", timeoutSeconds: 10, extra: 1 } }), "bad_action"],
      [signed({ params: { container: "ghost", timeoutSeconds: 10 } }), "unknown_container"],
    ];
    for (const [cmd, reason] of cases) {
      expect(verifyCommand(cmd as never, ctx()), reason).toMatchObject({ ok: false, reason });
    }
  });
});

describe("operationsTick: the socket is touched ONLY for a valid command", () => {
  it("a valid command: ONE call, the one of the table, and the result is reported", async () => {
    const h = harness(signed());
    expect(await tick(h)).toBe("ran");
    expect(h.calls).toEqual([{ method: "POST", path: "/containers/web/restart?t=10" }]);
    expect(h.reports[0]!.body).toEqual({ exitCode: 0, output: "" });
  });

  it("NEGATIVE: every refusal leaves the socket at ZERO calls (and is reported as refused)", async () => {
    for (const cmd of [
      { ...signed(), signature: "AAAA" },
      signed({}, other.privateKey),
      signed({ serverId: "44444444-4444-4444-8444-444444444444" }),
      signed({ expiresAt: "2026-11-14T09:00:00.000Z" }),
      signed({ action: "compose.up", params: {} }),
      signed({ params: { container: "../etc", timeoutSeconds: 10 } }),
    ]) {
      const h = harness(cmd);
      expect(await tick(h)).toBe("refused");
      expect(h.calls).toHaveLength(0);
      expect(h.reports[0]!.body).toMatchObject({ exitCode: 126 });
    }
  });

  it("NEGATIVE: server id not known yet (no config) → refused, zero calls", async () => {
    const h = harness(signed());
    expect(await tick(h, memoryNonces(), null)).toBe("refused");
    expect(h.calls).toHaveLength(0);
  });

  it("the same command delivered twice runs once", async () => {
    const nonces = memoryNonces();
    const cmd = signed();
    const a = harness(cmd);
    const b = harness(cmd);
    expect(await tick(a, nonces)).toBe("ran");
    expect(await tick(b, nonces)).toBe("refused");
    expect(b.calls).toHaveLength(0);
  });
});

describe("the fixed table", () => {
  it("each action maps to exactly one Docker call; prune only its three variants", () => {
    expect(dockerCallFor({ action: "container.start", params: { container: "web" } })).toEqual({ method: "POST", path: "/containers/web/start" });
    expect(dockerCallFor({ action: "container.stop", params: { container: "web", timeoutSeconds: 5 } })).toEqual({ method: "POST", path: "/containers/web/stop?t=5" });
    expect(dockerCallFor({ action: "docker.prune", params: { what: "build_cache" } })).toEqual({ method: "POST", path: "/build/prune" });
    expect(dockerCallFor({ action: "docker.prune", params: { what: "stopped_containers" } })).toEqual({ method: "POST", path: "/containers/prune" });
    expect(dockerCallFor({ action: "docker.prune", params: { what: "images_unused" } }).path.startsWith("/images/prune?filters=")).toBe(true);
    expect(dockerCallFor({ action: "container.state", params: { container: "web" } })).toEqual({ method: "GET", path: "/containers/web/json" });
    expect(dockerCallFor({ action: "container.logs", params: { container: "web", lines: 50, sinceMinutes: 10 } }, NOW).path).toBe(`/containers/web/logs?stdout=1&stderr=1&tail=50&since=${Math.floor(NOW.getTime() / 1000) - 600}`);
  });

  it("the state read keeps only state, restarts and image", async () => {
    const out = await executeAction(async () => ({ statusCode: 200, body: JSON.stringify({ State: { Status: "running" }, RestartCount: 3, Config: { Image: "web:1", Env: ["SECRET=x"] } }) }), { action: "container.state", params: { container: "web" } });
    expect(JSON.parse(out.output)).toEqual({ state: { Status: "running" }, restartCount: 3, image: "web:1" });
    expect(out.output).not.toContain("SECRET");
  });
});

describe("review F4b, I2: l'id del server si fissa anche dopo un avvio senza config", () => {
  it("senza id all'inizio, il giro lo chiede PRIMA di verificare: il comando valido gira", async () => {
    const h = harness(signed());
    let serverId: string | null = null;
    const out = await operationsTick({
      baseUrl: "https://s.example",
      serverKey: "sk_x",
      publicKey: PUBLIC,
      nonces: memoryNonces(),
      docker: h.docker,
      seenContainers: () => ["web", "db"],
      serverId: () => serverId,
      refreshServerId: async () => {
        serverId = SERVER;
      },
      fetchFn: h.fetchFn,
      now: () => NOW,
    });
    expect(out).toBe("ran");
  });
});

describe("review F4b: un'azione che cambia senza approvazione si rifiuta", () => {
  it("container.restart firmato ma con approvalId null → bad_action, nessuna chiamata", async () => {
    const h = harness(signed({ action: "container.restart", params: { container: "web", timeoutSeconds: 10 }, approvalId: null }));
    expect(await tick(h)).toBe("refused");
    expect(h.calls).toHaveLength(0);
  });
});
