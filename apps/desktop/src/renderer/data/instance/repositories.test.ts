import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { instance, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { revokeProjectPermission } from "../viewer";

// I repository di tutta l'istanza (area 9b, Task 7): raggruppati per
// progetto, solo i progetti dove chi guarda ha `repos.view`, e solo per chi
// ha `repos.manage` in almeno uno (Ruling 20: Sara è il caso negativo).

const as = (personId: string) => setSessionPersonId(personId);

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

describe("listAllRepositories", () => {
  it("Roberta: un gruppo per progetto con repository, col nome, il nome completo, l'account e il link", async () => {
    as("p-roberta");
    const groups = await instance.listAllRepositories();
    expect(groups.length).toBeGreaterThan(1);
    const withRepos = new Set(state.repositories.map((r) => r.projectId));
    expect(groups.map((g) => g.projectId).sort()).toEqual([...withRepos].sort());
    const stw = groups.find((g) => g.projectCode === "STW")!;
    expect(stw.projectName).toBe(state.projectsById.get("prj-stw")!.name);
    expect(stw.repositories.find((r) => r.id === "repo-stw")).toEqual({
      id: "repo-stw",
      name: "stubwise",
      fullName: "stubwise/stubwise",
      gitAccountName: "GitHub Stubwise",
      href: "#/p/STW/settings/repositories",
    });
    // Per progetto, alfabetici.
    const names = groups.map((g) => g.projectName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("senza repos.manage in nessun progetto (Sara) → forbidden", async () => {
    as("p-sara");
    await expect(instance.listAllRepositories()).rejects.toThrow("forbidden");
  });

  it("solo i progetti dove chi guarda ha repos.view", async () => {
    as("p-laura");
    const before = (await instance.listAllRepositories()).map((g) => g.projectCode);
    expect(before.length).toBeGreaterThan(0);
    const [first] = before;
    const projectId = [...state.projectsById.values()].find((p) => p.code === first)!.id;
    // `repos.view` è un permesso di `@stubwise/shared`: il cast serve solo al tipo.
    revokeProjectPermission(
      "p-laura",
      projectId,
      "repos.view" as Parameters<typeof revokeProjectPermission>[2],
    );
    const after = (await instance.listAllRepositories()).map((g) => g.projectCode);
    expect(after).not.toContain(first);
    expect(after).toHaveLength(before.length - 1);
  });

  it("un repository senza account git ha gitAccountName null", async () => {
    as("p-roberta");
    state.repositories.find((r) => r.id === "repo-stw")!.gitAccountId = null;
    const stw = (await instance.listAllRepositories()).find((g) => g.projectCode === "STW")!;
    expect(stw.repositories.find((r) => r.id === "repo-stw")!.gitAccountName).toBeNull();
  });
});
