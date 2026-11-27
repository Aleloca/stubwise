import type * as Fake from "../../../api";
import type { VaultStatusView } from "../../../vault/types";
import { partialNamespace } from "../notIntegrated";
import * as liveVaultReads from "../vaultReads";
import { setVaultTransport } from "../vaultReads";

// La cassaforte della build web servita su `/app` (`@backend/vault`, target
// `web`, design della cassaforte nel browser §4): la chiave starà nella
// scheda (`vaultBrowser/`, fase 1). Questo modulo NON nomina il ponte del
// desktop (`check-vault-target.mjs`). Finché lo sblocco nel browser non c'è,
// la barra dice `unsupported` come prima e le letture vengono dalle rotte.

setVaultTransport(null);

const getVaultStatus: typeof Fake.vault.getVaultStatus = async (): Promise<VaultStatusView> => ({
  state: "unsupported",
  touchId: false,
  macFingerprint: null,
  ownFingerprint: null,
  pairing: null,
});

export const vault: typeof Fake.vault = partialNamespace<typeof Fake.vault>("vault", {
  getVaultStatus,
  ...liveVaultReads,
});
