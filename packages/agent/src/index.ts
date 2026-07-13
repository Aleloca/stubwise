/**
 * Entry point for the Stubwise monitoring agent.
 *
 * For now this only re-exports the collectors so the esbuild bundle has a valid
 * entry and they are importable. The real collect → buffer → push main loop
 * lands in Task D4.
 */
export { parseCpu, parseLoadavg, parseMeminfo, parseNetDev } from "./collectors/proc.js";
export { collectDisks, type DiskUsage, type CollectDisksOptions } from "./collectors/disk.js";
export {
  collectDockerServices,
  type CollectDockerOptions,
} from "./collectors/docker.js";
export { collectPm2Services, type CollectPm2Options } from "./collectors/pm2.js";
