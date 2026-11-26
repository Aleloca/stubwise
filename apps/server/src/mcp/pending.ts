/**
 * Le rotte non ancora dichiarate per l'MCP (design
 * `docs/plans/2026-11-26-mcp-parita-design.md` § 2, «La transizione»). Si
 * può solo ACCORCIARE: `mcp-parity.test.ts` fallisce se una voce è già
 * dichiarata, se la esclude il registro o se non esiste più, e se una rotta
 * nuova non dichiara `config.mcp`. Sparisce all'ultimo lotto.
 */
/**
 * Il tetto di `PENDING_MCP`: si abbassa SOLTANTO, a ogni lotto, fino a zero.
 * Senza, una rotta nuova si accoderebbe all'elenco e il test passerebbe.
 */
export const PENDING_MCP_MAX = 0;

export const PENDING_MCP: readonly string[] = [
];
