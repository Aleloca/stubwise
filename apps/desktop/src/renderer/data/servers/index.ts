// I Server (area 8b) come li espone `api.ts`: `api.servers.<funzione>`. Chi
// vede che cosa e gli stati derivati li decide `visibility.ts` con le regole
// pure di `domain/servers`; `monitor.ts` sono le scritture della sezione
// Monitor del web (`monitor.manage`); `access.ts` gli accessi SSH
// (`servers.ssh.manage`), `simulate.ts` i «Simula …» del solo prototipo.
// `secrets.ts` (le chiavi private) NON si esporta: lo importano solo
// `access.ts`, `analysis.ts` e `fix.ts`.

export {
  getInstallCommand,
  getServer,
  getServerMetrics,
  listProjectServers,
  searchServers,
  type MetricRange,
  type ServerMetrics,
  type ServerSearchResult,
} from "./reads";
export {
  createCheck,
  createServer,
  deleteCheck,
  deleteServer,
  regenerateAgentKey,
  setThresholds,
  updateCheck,
  updateServer,
  type CheckInput,
  type CreateServerInput,
  type UpdateServerInput,
} from "./monitor";
export { linkSshAccess, regenerateSshAccess, revokeSshAccess, verifySshAccess } from "./access";
export { simulateSshVerifyOutcome } from "./simulate";
export {
  RECENT_CPU_POINTS,
  serverHref,
  type ServerDetail,
  type ServerEpisodeView,
  type ServerRow,
  type SshAccessView,
  type SshUseView,
} from "./visibility";
