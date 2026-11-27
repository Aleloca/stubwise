import { z } from "zod";

/**
 * La CSP dell'origine (indurimento di sicurezza, C1/M1) ha `script-src 'self'`
 * senza `'unsafe-eval'`. Zod v4, alla prima validazione, prova
 * `new Function("")` per accorciare i parse (il suo JIT): con la CSP il
 * tentativo fallisce, Zod ripiega da sé, ma il browser registra una
 * violazione a ogni avvio. Chiamata PRIMA di qualunque parse (il primo import
 * dei `main.tsx`), la sonda non parte. Costa solo il JIT dei parse.
 */
export function zodWithoutEval(): void {
  z.config({ jitless: true });
}
