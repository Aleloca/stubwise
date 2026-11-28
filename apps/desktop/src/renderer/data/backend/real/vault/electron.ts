import type { CredentialItem, Reader } from "@stubwise/shared";
import type * as Fake from "../../../api";
import { partialNamespace } from "../notIntegrated";
import * as liveVaultDesktop from "../vaultDesktop";
import { listPending } from "../vaultDesktop";
import * as liveVaultReads from "../vaultReads";
import { setVaultTransport, type VaultTransport } from "../vaultReads";
import { listMacsOf, removeMacOf } from "../vaultMacsOf";

// La cassaforte della build Electron (`@backend/vault`, target `electron`,
// design della cassaforte nel browser §4): la chiave sta nel main, e le
// pagine lo raggiungono dal ponte (`window.stubwise.vault`, rotte del PAT
// del desktop). Solo questo modulo, e `vaultDesktop.ts`, nominano il ponte:
// `scripts/check-vault-target.mjs` verifica che la build web non lo abbia.

/** Il trasporto del main (esportato per i test che simulano il ponte). */
export const mainTransport: VaultTransport = {
  async mine() {
    const b = window.stubwise?.vault;
    if (!b?.mine) throw new Error("vault_bridge_missing");
    const out = await b.mine();
    if (!out.ok) throw new Error(out.code);
    return out.items as Reader<CredentialItem>[];
  },
  async setPassword(id, password) {
    const b = window.stubwise?.vault;
    if (!b) return { ok: false, code: "unsupported" };
    const out = await b.setPassword(id, password);
    return out.ok ? { ok: true, resaved: out.resaved === true } : { ok: false, code: out.code };
  },
  async create(projectId, fields, password) {
    const b = window.stubwise?.vault;
    if (!b) return { ok: false, code: "unsupported" };
    const out = await b.create(projectId, fields, password);
    return out.ok ? { ok: true, id: out.id, resaved: out.resaved === true } : { ok: false, code: out.code };
  },
  pending: listPending,
};

setVaultTransport(mainTransport);

export const vault: typeof Fake.vault = partialNamespace<typeof Fake.vault>("vault", {
  // Fetta 1: stato, aprire e chiudere, associazione, i propri Mac (dal main).
  ...liveVaultDesktop,
  // Fetta 2b: elenchi, dettaglio ed entrate, dalle rotte.
  ...liveVaultReads,
  // Ritiro del web vecchio (inventario 1.2): i Mac di un'altra persona, dal browser.
  listMacsOf,
  removeMacOf,
});
