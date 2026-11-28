import type * as Web from "./setup-web";

// `@backend/vault-setup` fuori dalla build web (prototipo, Electron, i test
// che non lo sostituiscono): la fase 2 della cassaforte (attivare, la
// propria chiave, una passkey in più, il kit, il recupero, l'associazione
// del Mac) si fa SOLO nella nuova app nel browser (design §4 e §10). Qui la
// stessa forma, e nessuna funzione: la pagina non c'è (il router non la
// registra) e chi la chiamasse riceve `unsupported`. Questo modulo NON nomina
// le rotte né la passkey (`check-vault-target.mjs`).

const unsupported = { ok: false as const, code: "unsupported" };

export const vaultSetupAvailable: typeof Web.vaultSetupAvailable = false;
export const vaultSetupStatus: typeof Web.vaultSetupStatus = async () => unsupported;
export const generateKit: typeof Web.generateKit = async () => unsupported;
export const forgetKit: typeof Web.forgetKit = async () => undefined;
export const activateVault: typeof Web.activateVault = async () => unsupported;
export const createVaultKey: typeof Web.createVaultKey = async () => unsupported;
export const addPasskeyToVault: typeof Web.addPasskeyToVault = async () => unsupported;
export const rotateRecoveryKit: typeof Web.rotateRecoveryKit = async () => unsupported;
export const loadRecoveryKit: typeof Web.loadRecoveryKit = async () => unsupported;
export const confirmWithRecoveryKit: typeof Web.confirmWithRecoveryKit = async () => unsupported;
export const forgetRecoveryKit: typeof Web.forgetRecoveryKit = async () => undefined;
export const lookupPairing: typeof Web.lookupPairing = async () => unsupported;
export const sealPairing: typeof Web.sealPairing = async () => unsupported;
export type { RecoveryPerson } from "./setup-web";
