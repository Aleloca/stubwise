// La regola di Claude sulla doc di prodotto (11b): PURA, senza stato e senza
// orologio. Una modifica entra da sola SOLO se il fatto è chiaro, non
// contraddice un blocco scritto da una persona, e chi agisce ha `docs.edit`;
// in ogni altro caso è una domanda o niente. Claude non scrive mai «deciso»
// per conto suo. Dall'integrazione dell'area 11 (F5) la regola sta in
// `@stubwise/shared` (`product-docs/claude-rule.ts`), la stessa per il worker
// (che la applica) e per il prototipo: qui solo la ri-esportazione.
export { decideFact, recommendedOf, type FactContext } from "@stubwise/shared";
