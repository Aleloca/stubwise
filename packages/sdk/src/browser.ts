// Entry point browser. La strumentazione automatica (errori globali,
// breadcrumb da click/navigazione/fetch) arriva con il task SDK browser.
export { BreadcrumbBuffer } from "./core/breadcrumbs.js";
export { Client, type ClientOptions } from "./core/client.js";
export { parseDsn, Transport, type ParsedDsn, type TransportOptions } from "./core/transport.js";
