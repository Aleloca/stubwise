// Zod senza compilazione JIT nella build web (Trusted Types, revisione I-4
// e I-A): per sapere se può compilare i parser zod prova un `new Function`
// già quando COSTRUISCE uno schema oggetto, cioè mentre i moduli di
// `@stubwise/shared` si valutano. Sotto `require-trusted-types-for 'script'`
// quella prova è una violazione segnalata, e nel worker della cassaforte
// non vogliamo nessun `eval`. Zod legge la sua configurazione globale da
// `globalThis.__zod_globalConfig` e la crea solo se manca: questo modulo,
// senza import, la imposta PRIMA di zod. Va importato per primo (`boot.ts`
// nella pagina, `worker.ts` nel worker; una guardia lo controlla), e
// `zodJitless.test.ts` fissa che zod la legga davvero da lì.

const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
// Sul posto: vale anche se zod fosse già stato caricato (tiene quell'oggetto).
(g.__zod_globalConfig ??= {}).jitless = true;

export {};
