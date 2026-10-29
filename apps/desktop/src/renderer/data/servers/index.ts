// I Server (area 8b) come li espone `api.ts`: `api.servers.<funzione>`. Chi
// vede che cosa e gli stati derivati li decide `visibility.ts` con le regole
// pure di `domain/servers`; `monitor.ts` sono le scritture della sezione
// Monitor del web (`monitor.manage`).

export {
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
export {
  RECENT_CPU_POINTS,
  serverHref,
  type ServerDetail,
  type ServerEpisodeView,
  type ServerRow,
} from "./visibility";
