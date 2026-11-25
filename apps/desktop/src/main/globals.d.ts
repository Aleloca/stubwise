/**
 * La cassaforte dal desktop nel build (revisione di sicurezza I1): vero solo
 * con `STUBWISE_VAULT_DESKTOP=on`, cioè nel pacchetto firmato
 * (`package:mac`). Lo scrive `define` di `electron.vite.config.ts`.
 */
declare const __STUBWISE_VAULT_DESKTOP__: boolean;
