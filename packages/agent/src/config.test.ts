import { describe, expect, it } from "vitest";

import { loadAgentEnv } from "./config.js";

describe("loadAgentEnv", () => {
  it("fails when STUBWISE_URL is missing", () => {
    const result = loadAgentEnv({ STUBWISE_SERVER_KEY: "k" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("STUBWISE_URL");
  });

  it("fails when STUBWISE_SERVER_KEY is missing", () => {
    const result = loadAgentEnv({ STUBWISE_URL: "https://x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("STUBWISE_SERVER_KEY");
  });

  it("lists both missing variables", () => {
    const result = loadAgentEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("STUBWISE_URL");
      expect(result.error).toContain("STUBWISE_SERVER_KEY");
    }
  });

  it("treats blank/whitespace values as missing", () => {
    const result = loadAgentEnv({ STUBWISE_URL: "   ", STUBWISE_SERVER_KEY: "k" });
    expect(result.ok).toBe(false);
  });

  it("applies defaults for optional variables", () => {
    const result = loadAgentEnv({
      STUBWISE_URL: "https://stub.example",
      STUBWISE_SERVER_KEY: "secret",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env).toEqual({
        baseUrl: "https://stub.example",
        serverKey: "secret",
        hostRoot: "/host",
        dockerSocket: "/var/run/docker.sock",
        agentVersion: "dev",
        operations: null,
      });
    }
  });

  it("strips trailing slashes from the URL", () => {
    const result = loadAgentEnv({
      STUBWISE_URL: "https://stub.example///",
      STUBWISE_SERVER_KEY: "secret",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.baseUrl).toBe("https://stub.example");
  });

  it("honours provided optional overrides", () => {
    const result = loadAgentEnv({
      STUBWISE_URL: "https://stub.example",
      STUBWISE_SERVER_KEY: "secret",
      HOST_ROOT: "/mnt/host",
      DOCKER_SOCKET: "/run/docker.sock",
      AGENT_VERSION: "1.2.3",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.hostRoot).toBe("/mnt/host");
      expect(result.env.dockerSocket).toBe("/run/docker.sock");
      expect(result.env.agentVersion).toBe("1.2.3");
    }
  });
});

describe("area 8, F4b: the operations option", () => {
  const base = { STUBWISE_URL: "https://x", STUBWISE_SERVER_KEY: "k" };
  it("off by default; on only with =1 AND the pinned public key", () => {
    const off = loadAgentEnv(base);
    expect(off.ok && off.env.operations).toBeNull();
    const noKey = loadAgentEnv({ ...base, STUBWISE_OPERATIONS: "1" });
    expect(noKey.ok).toBe(false);
    const on = loadAgentEnv({ ...base, STUBWISE_OPERATIONS: "1", STUBWISE_COMMAND_PUBLIC_KEY: "PUB" });
    expect(on.ok && on.env.operations).toEqual({ publicKey: "PUB", nonceFile: "/var/lib/stubwise-agent/nonces.json" });
    const other = loadAgentEnv({ ...base, STUBWISE_OPERATIONS: "true", STUBWISE_COMMAND_PUBLIC_KEY: "PUB" });
    expect(other.ok && other.env.operations).toBeNull();
  });
});
