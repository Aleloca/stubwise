import { describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "./dispatch.js";
import { publishRequestCreated } from "./request-created.js";

const INPUT = {
  requestKind: "bug" as const,
  projectId: "p1",
  projectName: "Apollo",
  title: "Crash",
  requesterEmail: "laura@cliente.test",
  ticketId: "t1",
  ticketNumber: 7,
  merged: false,
  url: "https://stubwise.test/tickets/t1",
};

describe("publishRequestCreated", () => {
  it("pubblica l'evento con l'ancora del progetto e del ticket", async () => {
    const publish = vi.fn().mockResolvedValue({ published: 1, notificationIds: [] });
    await publishRequestCreated({} as DbOrTx, INPUT, { publish });
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "request.created", requestKind: "bug", merged: false }),
      { projectId: "p1", ticketId: "t1" },
    );
  });

  it("una voce di backlog ancora solo il progetto (nessun ticketId)", async () => {
    const publish = vi.fn().mockResolvedValue({ published: 1, notificationIds: [] });
    await publishRequestCreated(
      {} as DbOrTx,
      {
        requestKind: "backlog",
        projectId: "p1",
        projectName: "Apollo",
        title: "Idea",
        requesterEmail: "laura@cliente.test",
        backlogItemId: "b1",
        merged: false,
        url: "https://stubwise.test/backlog/b1",
      },
      { publish },
    );
    expect(publish.mock.calls[0]![2]).toEqual({ projectId: "p1" });
  });

  it("non lancia se la publish lancia", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("db giù"));
    await expect(
      publishRequestCreated({} as DbOrTx, INPUT, { publish: failing }),
    ).resolves.toBeUndefined();
  });
});
