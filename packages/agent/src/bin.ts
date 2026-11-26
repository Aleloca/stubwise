/**
 * Executable entry point for the Stubwise monitoring agent (the esbuild bundle
 * `dist/agent.cjs` is built from THIS file). Reads the environment, wires the
 * real dependencies (proc/collector-based sampler, check runner, ingest client)
 * and starts the main loop, with graceful shutdown on SIGTERM/SIGINT.
 *
 * Kept separate from `index.ts` so importing the library surface never boots
 * the agent as a side effect.
 */
import { pruneCheckState, runCheck } from "./checks/run.js";
import { loadAgentEnv } from "./config.js";
import { consoleLogger, IngestClient } from "./ingest-client.js";
import { Pool } from "undici";
import { startOperationsLoop } from "./operations/loop.js";
import { fileNonceStore } from "./operations/nonces.js";
import {
  DEFAULT_SAMPLE_INTERVAL_SECONDS,
  makeCollectSample,
  resolveHostname,
  runAgentLoop,
} from "./main.js";

async function bootstrap(): Promise<void> {
  const loaded = loadAgentEnv(process.env);
  if (!loaded.ok) {
    consoleLogger.error(loaded.error);
    process.exit(1);
  }
  const env = loaded.env;

  const hostname = await resolveHostname(env.hostRoot);
  consoleLogger.info("starting agent", { hostname, version: env.agentVersion, url: env.baseUrl });

  const client = new IngestClient({
    baseUrl: env.baseUrl,
    serverKey: env.serverKey,
    hostname,
    agentVersion: env.agentVersion,
    operations: env.operations !== null,
  });

  // Fetch the initial config; fall back to the default interval with no checks
  // if the server is unreachable at startup. `configPending` makes the loop
  // retry the fetch on every tick until a real config arrives (instead of
  // waiting for the 10-tick refresh cadence).
  const fetched = await client.fetchConfig();
  const initialConfig = fetched ?? {
    sampleIntervalSeconds: DEFAULT_SAMPLE_INTERVAL_SECONDS,
    checks: [],
  };

  const baseCollect = makeCollectSample({
    hostRoot: env.hostRoot,
    dockerSocket: env.dockerSocket,
  });
  // Area 8, F4b: the containers the agent sees (a command may only name one of these).
  let seen: string[] = [];
  const collectSample: typeof baseCollect = async () => {
    const sample = await baseCollect();
    if (sample) seen = sample.services.filter((s) => s.source === "docker").map((s) => s.name);
    return sample;
  };
  // This server's id, PINNED from the first config that carries it.
  let serverId: string | null = fetched?.serverId ?? null;

  const abort = new AbortController();
  const controller = runAgentLoop(
    {
      collectSample,
      runCheck: (config) => runCheck(config, { procRoot: `${env.hostRoot}/proc` }),
      client,
      pruneCheckState,
    },
    { initialConfig, configPending: fetched === null, signal: abort.signal },
  );

  // Area 8, F4b: the operations loop, only with STUBWISE_OPERATIONS=1.
  let stopOperations: (() => void) | null = null;
  if (env.operations) {
    const pool = new Pool("http://localhost", { socketPath: env.dockerSocket, connections: 1 });
    const pinServerId = async () => {
      if (serverId === null) serverId = (await client.fetchConfig())?.serverId ?? null;
    };
    stopOperations = startOperationsLoop({
      baseUrl: env.baseUrl,
      serverKey: env.serverKey,
      publicKey: env.operations.publicKey,
      nonces: fileNonceStore(env.operations.nonceFile),
      docker: async (call) => {
        // Oltre il `timeoutSeconds` più lungo ammesso (120 s) per uno stop/restart.
        const { statusCode, body } = await pool.request({ method: call.method, path: call.path, signal: AbortSignal.timeout(180_000) });
        return { statusCode, body: await body.text() };
      },
      seenContainers: () => seen,
      serverId: () => serverId,
      refreshServerId: pinServerId,
      log: (msg) => consoleLogger.info(msg),
    });
    consoleLogger.info("operations enabled: only signed commands of the closed set");
  }

  const shutdown = (signal: string) => {
    consoleLogger.info("shutting down", { signal });
    stopOperations?.();
    abort.abort();
    void controller.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void bootstrap();
