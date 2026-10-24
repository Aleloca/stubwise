import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { clearToasts } from "../../tasks-ui/Toast";
import { renderRoute } from "../../test/renderRoute";

// Il pannello della richiesta: le proposte dell'intake sui metadati («was
// X», Accept all / Dismiss con `backlog.edit`) e la riga del prossimo passo,
// derivata da richiesta, task e lavoro di Claude.

const request = (id: string) => state.requests.find((r) => r.id === id)!;
const panel = () => screen.findByRole("dialog", { name: "Request" });
const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  clearToasts();
});

describe("richiesta: proposte dell'intake", () => {
  it("dicono campo, valore proposto, «was» e perché; «Accept all» le scrive", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
    const dialog = await panel();
    const box = await within(dialog).findByRole("region", { name: "Suggested by the intake" });
    const rows = within(within(box).getByRole("list", { name: "Suggested changes" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      "SizeLwas: “M”",
      "Risk noteThe showroom date is fixed and the page needs the booking form: no room to slip.was: “The showroom date is fixed: no room to slip.”",
    ]);
    expect(box).toHaveTextContent(/booking form and a map/);
    await userEvent.click(within(box).getByRole("button", { name: "Accept all" }));
    await waitFor(() => expect(request("req-mkx-2").suggestions ?? null).toBeNull());
    expect(request("req-mkx-2").size).toBe("L");
    expect(request("req-mkx-2").riskNote).toMatch(/booking form/);
    // Il resto è com'era: l'urgenza non era fra le proposte.
    expect(request("req-mkx-2").urgency).toBe("high");
    await waitFor(() =>
      expect(within(dialog).queryByRole("region", { name: "Suggested by the intake" })).toBeNull(),
    );
    expect(within(dialog).getByRole("button", { name: "Size: L. Change" })).toBeInTheDocument();
  });

  it("un campo vuoto dice «was: empty»; «Dismiss» le toglie senza cambiare i metadati", async () => {
    renderRoute("/p/STW/requests?request=req-stw-1", "p-laura");
    const dialog = await panel();
    const box = await within(dialog).findByRole("region", { name: "Suggested by the intake" });
    expect(box).toHaveTextContent("UrgencyLowwas: “Medium”");
    expect(box).toHaveTextContent("SizeSwas: empty");
    expect(box).toHaveTextContent("RiskLowwas: empty");
    await userEvent.click(within(box).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(request("req-stw-1").suggestions ?? null).toBeNull());
    expect(request("req-stw-1").size ?? null).toBeNull();
    expect(request("req-stw-1").urgency).toBe("medium");
  });

  it("senza backlog.edit si leggono, ma non si accettano né si scartano", async () => {
    renderRoute("/p/STW/requests?request=req-stw-1", "p-sara");
    const dialog = await panel();
    const box = await within(dialog).findByRole("region", { name: "Suggested by the intake" });
    expect(within(box).queryByRole("button", { name: "Accept all" })).toBeNull();
    expect(within(box).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("«Accept all» che non riesce lo dice, e le proposte restano", async () => {
    failNext("updateRequest");
    renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
    const dialog = await panel();
    const box = await within(dialog).findByRole("region", { name: "Suggested by the intake" });
    await userEvent.click(within(box).getByRole("button", { name: "Accept all" }));
    expect(await screen.findByText("That didn't go through. Try again.")).toBeInTheDocument();
    expect(request("req-mkx-2").suggestions).not.toBeNull();
    expect(request("req-mkx-2").size).toBe("M");
  });

  it("una richiesta senza proposte non ha il riquadro", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-3", "p-giulia");
    const dialog = await panel();
    await within(dialog).findByRole("heading", { name: "Short video for the kitchens line" });
    expect(within(dialog).queryByRole("region", { name: "Suggested by the intake" })).toBeNull();
  });
});

describe("richiesta: il prossimo passo", () => {
  const nextStep = async () => {
    const dialog = await panel();
    return waitFor(() => {
      const el = dialog.querySelector<HTMLElement>("[data-next-step]");
      if (!el) throw new Error("no next step");
      return el;
    });
  };

  it("nuova: da chiarire", async () => {
    renderRoute("/p/STW/requests?request=req-stw-1", "p-laura");
    expect(await nextStep()).toHaveTextContent("Still to clarify: keep refining it.");
  });

  it("pronta: da trasformare in task", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-3", "p-giulia");
    expect(await nextStep()).toHaveTextContent("Ready: turn it into a task.");
  });

  it("trasformata con Claude al lavoro: «In progress» e «Go to STW-3» apre la task", async () => {
    const router = renderRoute("/p/STW/requests?request=req-stw-2", "p-laura");
    const line = await nextStep();
    await waitFor(() => expect(line).toHaveTextContent("In progress."));
    await userEvent.click(within(line).getByRole("button", { name: "Go to STW-3" }));
    await waitFor(() => expect(search(router).task).toBe("STW-3"));
  });

  it("Claude ha finito e la PR è aperta: la modifica è pronta", async () => {
    state.tasksById.get("t-stw-3")!.claude = "done";
    renderRoute("/p/STW/requests?request=req-stw-2", "p-laura");
    const line = await nextStep();
    await waitFor(() =>
      expect(line).toHaveTextContent("Change ready: merging it is up to someone who can release."),
    );
  });

  it("archiviata: nessuna riga", async () => {
    renderRoute("/p/STW/requests?request=req-stw-3", "p-laura");
    const dialog = await panel();
    await within(dialog).findByRole("heading", { name: "Drag and drop on the board" });
    expect(dialog.querySelector("[data-next-step]")).toBeNull();
  });
});
