import { describe, expect, it, vi } from "vitest";
import { confirmEditedVia } from "./ProposalCard";

// Registro dei rimandi, «Classe C… confirmEdited salta il wrapper
// `reauth()`» (F7, Task 6): la conferma di una proposta MODIFICATA passa
// dalla riconferma come Confirm. Con una C il server risponde
// `reauth_required`; il wrapper chiede il codice e la rimanda uguale.

type Reauth = <R>(
  call: () => Promise<R>,
  opts: { action: string },
) => Promise<R | { ok: false; error: "reauth_cancelled" }>;

/** Il wrapper vero in piccolo: al primo `reauth_required` «riconferma» e riprova una volta. */
const fakeReauth = (accept: boolean) => {
  const asked: string[] = [];
  const run: Reauth = async (call, { action }) => {
    const first = await call();
    if ((first as { error?: string }).error !== "reauth_required") return first;
    asked.push(action);
    if (!accept) return { ok: false, error: "reauth_cancelled" };
    return call();
  };
  return { run, asked };
};

describe("confirmEdited passa dalla riconferma", () => {
  it("una C: il primo invio chiede il codice, il secondo esegue con gli stessi argomenti modificati", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "reauth_required" })
      .mockResolvedValueOnce({ status: "confirmed" });
    const { run, asked } = fakeReauth(true);
    const result = await confirmEditedVia(run, send, "To add Marco")(0, { roleId: "lead" });
    expect(result).toEqual({ status: "confirmed" });
    expect(asked).toEqual(["To add Marco"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(2, [{ index: 0, args: { roleId: "lead" } }]);
  });

  it("riconferma annullata: rifiuta, e il dialogo lo dice (niente eseguito)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: "reauth_required" });
    const { run } = fakeReauth(false);
    await expect(confirmEditedVia(run, send, "x")(0, {})).rejects.toThrow("reauth_cancelled");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("un secondo reauth_required dopo il codice non è un successo: rifiuta (review F7, M3)", async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, error: "reauth_required" });
    const { run } = fakeReauth(true);
    await expect(confirmEditedVia(run, send, "x")(0, {})).rejects.toThrow("reauth_required");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("una conferma che il server non esegue (failed) rifiuta col suo errore", async () => {
    const send = vi.fn().mockResolvedValue({ status: "failed", error: "conflict" });
    const { run } = fakeReauth(true);
    await expect(confirmEditedVia(run, send, "x")(0, {})).rejects.toThrow("conflict");
  });
});
