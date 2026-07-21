import type { Db } from "@stubwise/db";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedProvider } from "../providers/chain.js";
import { resolveBacklogProvider } from "./provider.js";

/**
 * Unit test PURI di resolveBacklogProvider: i loader sono iniettati, quindi il
 * db non viene mai toccato (un oggetto sentinella basta) e non serve alcun
 * testcontainer. Il contratto è best-effort come il daily-report: pinned non
 * risolvibile o catena vuota → undefined (auth del container), MAI un errore.
 */

const PINNED: ResolvedProvider = { id: "pinned-1", kind: "api_key", secret: "sk-pinned" };
const FIRST: ResolvedProvider = { id: "chain-1", kind: "account", secret: "tok-first" };
const SECOND: ResolvedProvider = { id: "chain-2", kind: "api_key", secret: "sk-second" };

// Sentinella: se un loader iniettato la usasse davvero, esploderebbe altrove.
const db = {} as Db;
const encryptionKey = Buffer.alloc(32);

describe("resolveBacklogProvider", () => {
  it("con aiProviderId risolvibile usa il pinned (la catena non viene toccata)", async () => {
    const loadProviderByIdFn = vi.fn(async () => PINNED);
    const loadProviderChainFn = vi.fn(async (): Promise<ResolvedProvider[]> => {
      throw new Error("la catena non deve essere caricata quando c'è un pinned");
    });

    const provider = await resolveBacklogProvider(
      { db, encryptionKey, loadProviderByIdFn, loadProviderChainFn },
      "pinned-1",
    );

    expect(provider).toEqual(PINNED);
    expect(loadProviderByIdFn).toHaveBeenCalledWith(db, encryptionKey, "pinned-1");
    expect(loadProviderChainFn).not.toHaveBeenCalled();
  });

  it("pinned NON risolvibile (disabilitato/eliminato/illeggibile) → undefined, senza fallback sulla catena", async () => {
    const loadProviderByIdFn = vi.fn(async () => null);
    const loadProviderChainFn = vi.fn(async () => [FIRST]);

    const provider = await resolveBacklogProvider(
      { db, encryptionKey, loadProviderByIdFn, loadProviderChainFn },
      "pinned-sparito",
    );

    expect(provider).toBeUndefined();
    // Niente fallback: il pinned è una scelta esplicita del progetto.
    expect(loadProviderChainFn).not.toHaveBeenCalled();
  });

  it("senza aiProviderId usa chain[0]", async () => {
    const loadProviderByIdFn = vi.fn(async () => PINNED);
    const loadProviderChainFn = vi.fn(async () => [FIRST, SECOND]);

    const provider = await resolveBacklogProvider(
      { db, encryptionKey, loadProviderByIdFn, loadProviderChainFn },
      null,
    );

    expect(provider).toEqual(FIRST);
    expect(loadProviderByIdFn).not.toHaveBeenCalled();
  });

  it("catena vuota → undefined (auth del container, comportamento storico)", async () => {
    const loadProviderChainFn = vi.fn(async (): Promise<ResolvedProvider[]> => []);

    const provider = await resolveBacklogProvider(
      { db, encryptionKey, loadProviderChainFn },
      null,
    );

    expect(provider).toBeUndefined();
  });
});
