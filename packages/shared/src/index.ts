export * from "./schemas/ticket.js";
export * from "./schemas/backlog.js";
export * from "./schemas/project.js";
export * from "./schemas/ingest.js";
export * from "./schemas/widget.js";
export * from "./schemas/language.js";
export * from "./schemas/docs.js";
export * from "./schemas/search.js";
export * from "./schemas/server.js";
export * from "./schemas/pat.js";
export * from "./env/dotenv.js";
// NOTA: `mirror-slug.js` NON è ri-esportato da questo barrel di proposito —
// importa `node:crypto` e apps/web importa questo index nel bundle browser
// (vite fallirebbe con "createHash is not exported by __vite-browser-external").
// È esposto come sottopercorso: `@stubwise/shared/mirror-slug`.
