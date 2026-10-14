import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRefineWorktreeRegistry, refineParentDir } from "./worktrees.js";

describe("registro dei worktree di refinement", () => {
  it("la parent dir è deterministica per sessione (il CLI indicizza --resume per cwd)", () => {
    expect(refineParentDir("abc")).toBe(join(tmpdir(), "stubwise-refine", "abc"));
    expect(refineParentDir("abc")).toBe(refineParentDir("abc"));
  });

  it("remove toglie dalla mappa PRIMA di smontare: due remove concorrenti smontano una volta", async () => {
    const reg = createRefineWorktreeRegistry();
    const remove = vi.fn(async () => undefined);
    reg.set({ agentSessionId: "s", parentDir: "/p", repos: [], remove });
    await Promise.all([reg.remove("s"), reg.remove("s")]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(reg.get("s")).toBeUndefined();
  });

  it("closeAll smonta tutto e non si ferma su un errore", async () => {
    const reg = createRefineWorktreeRegistry();
    const ok = vi.fn(async () => undefined);
    reg.set({
      agentSessionId: "a",
      parentDir: "/a",
      repos: [],
      remove: async () => {
        throw new Error("x");
      },
    });
    reg.set({ agentSessionId: "b", parentDir: "/b", repos: [], remove: ok });
    await reg.closeAll();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(reg.ids()).toEqual([]);
  });
});
