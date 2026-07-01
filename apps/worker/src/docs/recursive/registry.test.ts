import { describe, expect, it } from "vitest";
import { createGenerationWorktreeRegistry } from "./registry.js";
import type { GenerationWorktree } from "../generation-worktree.js";

// Unit test PURO del registro in-processo (niente DB): il registro traccia i
// worktree di generazione aperti e ne deriva gli insiemi per la mutua esclusione
// col fix — `activeRepositoryIds` (guardia nuova-generazione) e `activeProjectIds`
// (esclusione dei fix di PROGETTO, Fase 3: un fix di progetto tiene worktree su
// tutti i repo del progetto).

function fakeWorktree(dir: string): GenerationWorktree {
  return { dir, commitSha: "0".repeat(40), close: async () => {} } as GenerationWorktree;
}

describe("GenerationWorktreeRegistry — activeProjectIds", () => {
  it("register aggiunge repo e progetto agli insiemi attivi; claimForFinalize li rimuove", () => {
    const reg = createGenerationWorktreeRegistry();
    expect(reg.activeRepositoryIds().size).toBe(0);
    expect(reg.activeProjectIds().size).toBe(0);

    reg.register("gen1", "repo1", "proj1", fakeWorktree("/tmp/wt1"));
    reg.register("gen2", "repo2", "proj1", fakeWorktree("/tmp/wt2"));
    reg.register("gen3", "repo3", "proj2", fakeWorktree("/tmp/wt3"));

    // Tre repo distinti, ma solo DUE progetti (repo1 e repo2 condividono proj1).
    expect(reg.activeRepositoryIds()).toEqual(new Set(["repo1", "repo2", "repo3"]));
    expect(reg.activeProjectIds()).toEqual(new Set(["proj1", "proj2"]));

    // Chiudo una delle due generazioni di proj1: proj1 resta attivo (l'altra è viva).
    expect(reg.claimForFinalize("gen1")).not.toBeNull();
    expect(reg.activeRepositoryIds()).toEqual(new Set(["repo2", "repo3"]));
    expect(reg.activeProjectIds()).toEqual(new Set(["proj1", "proj2"]));

    // Chiudo anche l'altra di proj1: ora proj1 non è più attivo.
    expect(reg.claimForFinalize("gen2")).not.toBeNull();
    expect(reg.activeProjectIds()).toEqual(new Set(["proj2"]));

    // Il worktree dir resta ricavabile finché la generazione è registrata.
    expect(reg.getWorktreeDir("gen3")).toBe("/tmp/wt3");
    reg.claimForFinalize("gen3");
    expect(reg.activeRepositoryIds().size).toBe(0);
    expect(reg.activeProjectIds().size).toBe(0);
  });
});
