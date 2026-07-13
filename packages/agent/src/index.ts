/**
 * Entry point for the Stubwise monitoring agent.
 *
 * For now (Task D1) this only re-exports the pure `/proc` parsers so the esbuild
 * bundle has a valid entry and the parsers are importable. The real collect →
 * buffer → push main loop lands in Task D4.
 */
export { parseCpu, parseLoadavg, parseMeminfo, parseNetDev } from "./collectors/proc.js";
