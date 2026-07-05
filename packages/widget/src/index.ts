/**
 * Entry del pacchetto `@stubwise/widget`.
 *
 * PLACEHOLDER (Task 9): per ora ri-esporta solo il core (DSN, API, SSE, storage),
 * così la build produce già i bundle ESM/IIFE. Il vero entry con `initWidget`
 * (montaggio Shadow DOM + UI Preact) arriva col Task 10.
 */
export * from "./core/dsn.js";
export * from "./core/api.js";
export * from "./core/sse.js";
export * from "./core/storage.js";
