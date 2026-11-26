// `@backend/runtime` nella build app (integrazione area 2, fetta 1), con le
// firme di `data/runtime.ts`: l'adesso è quello vero; lo store finto non
// esiste, quindi nessun «reset» da ascoltare.
import type * as Fake from "../../runtime";
import { notIntegrated } from "./notIntegrated";

export const now: typeof Fake.now = () => new Date().toISOString();

export const onStoreReset: typeof Fake.onStoreReset = () => {};

/**
 * Gli accessi cambiano sul server, non in questo client: nessun avviso da
 * ascoltare (le scritture dell'app invalidano già le loro query). Sta qui e
 * non in `data/access/state.ts`, che importa il seme degli accessi: preso da
 * lì portava il seme nel bundle dell'app (25 nov 2026).
 */
export const subscribeAccess: typeof Fake.subscribeAccess = () => () => {};

/** Support (area 8a) non è integrato: la scrittura simulata non esiste. */
export const streamText: typeof Fake.streamText = notIntegrated("streamText") as never;
