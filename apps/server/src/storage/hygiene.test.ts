import { describe, expect, it, vi } from "vitest";
import { runStorageHygiene } from "./hygiene.js";

// La pulizia oraria dello storage (review della fetta 2): ogni passo nel SUO
// try, così una potatura della Chat che fallisce non salta quella del Drive.
describe("runStorageHygiene", () => {
  it("un passo che lancia non ferma i successivi, e si registra col suo nome", async () => {
    const log = vi.fn();
    const drive = vi.fn(async () => 3);
    await runStorageHygiene(
      [
        { name: "chat", run: async () => Promise.reject(new Error("giù")) },
        { name: "drive", run: drive },
      ],
      log,
    );
    expect(drive).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![1]).toBe("chat");
  });
});
