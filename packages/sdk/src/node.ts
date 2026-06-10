// Entry point Node. Gli helper specifici (uncaughtException, ecc.)
// arrivano con il task SDK Node.
export { BreadcrumbBuffer } from "./core/breadcrumbs.js";
export { Client, type ClientOptions } from "./core/client.js";
export { parseDsn, Transport, type ParsedDsn, type TransportOptions } from "./core/transport.js";
