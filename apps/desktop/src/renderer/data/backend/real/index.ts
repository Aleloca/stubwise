// Il livello dati della build «app» (integrazione area 2, fetta 1): lo stesso
// insieme di nomi di `data/api.ts`, risolto da `@backend/api` quando
// `STUBWISE_BUILD=app` (`vite.backend.ts`). Parte dagli stub «non integrati»
// generati; un'esportazione locale qui sotto prevale sulla stella (Task
// 16–17), ed è tipata `typeof Fake.<nome>` con un `import type`, così il
// finto non entra mai nel bundle.
export * from "./stubs.generated";
