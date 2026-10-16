import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "./dispatch.js";
import { buildDocsNightlyAttentionEvent, publishDocsNightlyAttention } from "./nightly-attention.js";

const INPUT = {
  reason: "item_failing" as const,
  repositoryId: "r1",
  repositoryName: "api",
  projectId: "p1",
  projectName: "Apollo",
  night: "2026-10-16",
  phase: "page_update",
  key: "page-1@abc",
  lastError: "boom",
  publicUrl: "https://stubwise.test/",
};

describe("publishDocsNightlyAttention", () => {
  it("costruisce l'evento con il docsUrl derivato (senza doppio slash)", () => {
    const event = buildDocsNightlyAttentionEvent(INPUT);
    expect(event.kind).toBe("docs.nightly_attention");
    expect(event.docsUrl).toBe("https://stubwise.test/docs/r1");
    expect("publicUrl" in event).toBe(false);
  });

  it("pubblica con l'ancora del progetto e non lancia se la publish lancia", async () => {
    const publish = vi.fn().mockResolvedValue({ published: 1, notificationIds: [] });
    await publishDocsNightlyAttention({} as DbOrTx, INPUT, { publish });
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "docs.nightly_attention", reason: "item_failing" }),
      { projectId: "p1" },
    );
    const failing = vi.fn().mockRejectedValue(new Error("db giù"));
    await expect(
      publishDocsNightlyAttention({} as DbOrTx, INPUT, { publish: failing }),
    ).resolves.toBeUndefined();
  });
});
