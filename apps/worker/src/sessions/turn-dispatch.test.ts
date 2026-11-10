import { describe, expect, it, vi } from "vitest";
import { turnDispatcher } from "./turn-dispatch.js";

describe("lo smistamento dei turni", () => {
  it("refinement e chat ai loro scheduler; un altro kind si scarta con un log", () => {
    const refine = vi.fn();
    const chat = vi.fn();
    const log = vi.fn();
    const dispatch = turnDispatcher({ refine, chat, log });
    dispatch("a", "backlog_refine");
    dispatch("b", "free");
    dispatch("c", "ai_job");
    dispatch("d", "");
    expect(refine.mock.calls).toEqual([["a"]]);
    expect(chat.mock.calls).toEqual([["b"]]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});
