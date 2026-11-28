import type * as Web from "./setup-web";

// `@backend/vault-setup` fuori dalla build web (prototipo, Electron, i test
// che non lo sostituiscono): la stessa forma e nessuna funzione. La fase 2
// della cassaforte sta nella pagina a sé del browser (`vaultPage/`). Questo
// modulo NON nomina le rotte né la passkey (`check-vault-target.mjs`).

export const vaultSetupAvailable: typeof Web.vaultSetupAvailable = false;
export const vaultSetupStatus: typeof Web.vaultSetupStatus = async () => ({ ok: false, code: "unsupported" });
