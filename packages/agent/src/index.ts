/**
 * Library surface of the Stubwise monitoring agent: parsers, collectors, check
 * runner, buffer, config, ingest client and the main loop. Pure re-exports with
 * NO side effects — the executable entry point (which boots the agent) is
 * `bin.ts`, bundled by esbuild into `dist/agent.cjs`.
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
  DEFAULT_SAMPLE_INTERVAL_SECONDS,
  type AgentLoopController,
  type AgentLoopDeps,
  type AgentLoopOptions,
} from "./main.js";
