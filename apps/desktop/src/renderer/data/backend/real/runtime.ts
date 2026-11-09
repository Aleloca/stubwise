// `@backend/runtime` nella build app (integrazione area 2, fetta 1), con le
// firme di `data/runtime.ts`: l'adesso è quello vero; lo store finto non
// esiste, quindi nessun «reset» da ascoltare.
import type * as Fake from "../../runtime";
import { notIntegrated } from "./notIntegrated";

export const now: typeof Fake.now = () => new Date().toISOString();

export const onStoreReset: typeof Fake.onStoreReset = () => {};

/** Support (area 8a) non è integrato: la scrittura simulata non esiste. */
export const streamText: typeof Fake.streamText = notIntegrated("streamText") as never;
