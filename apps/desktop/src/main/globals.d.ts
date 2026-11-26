/**
 * La cassaforte dal desktop nel build (revisione di sicurezza I1): vero solo
 * con `STUBWISE_VAULT_DESKTOP=on`, cioè nel pacchetto firmato
 * (`package:mac`). Lo scrive `define` di `electron.vite.config.ts`.
 */
declare const __STUBWISE_VAULT_DESKTOP__: boolean;

/**
 * Il Team ID con cui sono firmati app e helper (I2, seconda revisione): il
 * requisito di firma dell'helper si costruisce da qui. Vuoto (un build non
 * firmato): la cassaforte dal desktop resta spenta. Da `STUBWISE_TEAM_ID`.
 */
declare const __STUBWISE_TEAM_ID__: string;
