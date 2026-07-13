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
  // if the server is unreachable at startup. `configPending` makes the loop
  // retry the fetch on every tick until a real config arrives (instead of
  // waiting for the 10-tick refresh cadence).
  const fetched = await client.fetchConfig();
  const initialConfig = fetched ?? {
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
    { initialConfig, configPending: fetched === null, signal: abort.signal },
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
