import type { ProjectPermission } from "@stubwise/shared";
import { describe, expect, it, vi } from "vitest";
import { memoPermissions } from "./permissions-memo.js";

/** I permessi di chi guarda per progetto, letti una volta sola: per pagina (elenco) o per 30 s (stream). */
describe("memoPermissions", () => {
  it("una lettura per progetto anche con chiamate concorrenti; dopo la scadenza si rilegge", async () => {
    let now = 1_000;
    const load = vi.fn(async (pid: string) => new Set<ProjectPermission>([pid === "p1" ? "repos.view" : "runs.start"]));
    const permissionsOf = memoPermissions(load, 30_000, () => now);
    const [a, b, c] = await Promise.all([permissionsOf("p1"), permissionsOf("p1"), permissionsOf("p2")]);
    expect([...a]).toEqual(["repos.view"]);
    expect(b).toBe(a);
    expect([...c]).toEqual(["runs.start"]);
    expect(load).toHaveBeenCalledTimes(2);
    now += 29_000;
    await permissionsOf("p1");
    expect(load).toHaveBeenCalledTimes(2);
    now += 2_000;
    await permissionsOf("p1");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("una lettura fallita non resta in cache", async () => {
    const load = vi
      .fn<(pid: string) => Promise<ReadonlySet<ProjectPermission>>>()
      .mockRejectedValueOnce(new Error("db giù"))
      .mockResolvedValue(new Set<ProjectPermission>(["repos.view"]));
    const permissionsOf = memoPermissions(load, 30_000);
    await expect(permissionsOf("p")).rejects.toThrow("db giù");
    expect([...(await permissionsOf("p"))]).toEqual(["repos.view"]);
  });
});
