/**
 * Executable entry point for the Stubwise monitoring agent.
 *
 * Reads the environment, wires the real dependencies (proc/collector-based
 * sampler, check runner, ingest client) and starts the main loop. Also
 * re-exports the library surface so tests and the D5 integration test can import
 * `runAgentLoop` & friends from `@stubwise/agent`.
 *
 * `node dist/agent.cjs` runs `bootstrap()` as a side effect; the library
 * re-exports below have no side effects on their own.
 */
export { parseCpu, parseLoadavg, parseMeminfo, parseNetDev } from "./collectors/proc.js";
export { collectDisks, type DiskUsage, type CollectDisksOptions } from "./collectors/disk.js";
export { collectDockerServices, type CollectDockerOptions } from "./collectors/docker.js";
export { collectPm2Services, type CollectPm2Options } from "./collectors/pm2.js";
export {
  runCheck,
  resetCheckState,
  pruneCheckState,
  type CheckContext,
} from "./checks/run.js";
export { RingBuffer } from "./buffer.js";
export { loadAgentEnv, type AgentEnv } from "./config.js";
export {
  IngestClient,
  consoleLogger,
  type IngestTransport,
  type SendResult,
  type Logger,
} from "./ingest-client.js";
export {
  runAgentLoop,
  makeCollectSample,
  resolveHostname,
  type AgentLoopController,
  type AgentLoopDeps,
} from "./main.js";

import { pruneCheckState, runCheck } from "./checks/run.js";
import { loadAgentEnv } from "./config.js";
import { consoleLogger, IngestClient } from "./ingest-client.js";
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
  });

  // Fetch the initial config; fall back to the default interval with no checks
  // if the server is unreachable at startup (the loop refreshes it later).
  const initialConfig = (await client.fetchConfig()) ?? {
    sampleIntervalSeconds: DEFAULT_SAMPLE_INTERVAL_SECONDS,
    checks: [],
  };

  const collectSample = makeCollectSample({
    hostRoot: env.hostRoot,
    dockerSocket: env.dockerSocket,
  });

  const abort = new AbortController();
  const controller = runAgentLoop(
    {
      collectSample,
      runCheck: (config) => runCheck(config, { procRoot: `${env.hostRoot}/proc` }),
      client,
      pruneCheckState,
    },
    { initialConfig, signal: abort.signal },
  );

  const shutdown = (signal: string) => {
    consoleLogger.info("shutting down", { signal });
    abort.abort();
    void controller.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void bootstrap();
