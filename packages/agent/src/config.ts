/**
 * Environment parsing for the agent's entry point. Kept pure (takes an env
 * record, returns a result) so it is unit-testable without touching
 * `process.env`. The entry point (`index.ts`) prints the error and exits 1 when
 * the required variables are missing.
 */

export interface AgentEnv {
  /** Base URL of the Stubwise server, trailing slashes stripped. */
  baseUrl: string;
  /** Per-server ingest key, sent as `x-stubwise-server-key`. */
  serverKey: string;
  /** Read-only mount of the host root filesystem tree (default `/host`). */
  hostRoot: string;
  /** Path to the Docker Engine Unix socket (default `/var/run/docker.sock`). */
  dockerSocket: string;
  /** Agent version string, baked in at build time (default `dev`). */
  agentVersion: string;
  /**
   * Area 8, F4b: the operations option (`STUBWISE_OPERATIONS=1`), OFF by
   * default. With it, `commandPublicKey` is required: the instance public key
   * pinned at install time (never fetched from the server).
   */
  operations: { publicKey: string; nonceFile: string } | null;
}

export type LoadAgentEnvResult =
  | { ok: true; env: AgentEnv }
  | { ok: false; error: string };

type EnvRecord = Record<string, string | undefined>;

/** Trim to a non-empty string, or `undefined` when absent/blank. */
function cleaned(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadAgentEnv(env: EnvRecord): LoadAgentEnvResult {
  const baseUrl = cleaned(env.STUBWISE_URL);
  const serverKey = cleaned(env.STUBWISE_SERVER_KEY);

  const missing: string[] = [];
  if (!baseUrl) missing.push("STUBWISE_URL");
  if (!serverKey) missing.push("STUBWISE_SERVER_KEY");
  if (!baseUrl || !serverKey) {
    return {
      ok: false,
      error: `Missing required environment variable(s): ${missing.join(", ")}`,
    };
  }

  const operationsOn = cleaned(env.STUBWISE_OPERATIONS) === "1";
  const publicKey = cleaned(env.STUBWISE_COMMAND_PUBLIC_KEY);
  if (operationsOn && !publicKey) {
    return { ok: false, error: "STUBWISE_OPERATIONS=1 needs STUBWISE_COMMAND_PUBLIC_KEY (the public key shown with the install command)" };
  }

  return {
    ok: true,
    env: {
      operations: operationsOn && publicKey ? { publicKey, nonceFile: cleaned(env.STUBWISE_NONCE_FILE) ?? "/var/lib/stubwise-agent/nonces.json" } : null,
      // Strip trailing slashes so `${baseUrl}/monitor/ingest` never doubles up.
      baseUrl: baseUrl.replace(/\/+$/, ""),
      serverKey,
      hostRoot: cleaned(env.HOST_ROOT) ?? "/host",
      dockerSocket: cleaned(env.DOCKER_SOCKET) ?? "/var/run/docker.sock",
      agentVersion: cleaned(env.AGENT_VERSION) ?? "dev",
    },
  };
}
