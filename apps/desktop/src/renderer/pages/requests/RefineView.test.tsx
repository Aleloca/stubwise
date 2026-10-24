import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { setMatchMedia } from "../../test/setup";
import { renderRoute } from "../../test/renderRoute";

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;
const request = (id: string) => state.requests.find((r) => r.id === id)!;
const side = () => screen.findByRole("region", { name: /^Request STW-R/ });
const sideOverlay = () => screen.findByRole("dialog", { name: /^Request STW-R/ });
const field = (name: string) =>
  document.querySelector(`[data-refine-field="${name}"] dd`) as HTMLElement;

/** Una scrittura a nome di `personId` mentre la sessione resta di chi guarda. */
async function as<R>(personId: string, call: () => Promise<R>): Promise<R> {
  const viewer = "p-laura";
  setSessionPersonId(personId);
  try {
    return await call();
  } finally {
    setSessionPersonId(viewer);
  }
}

beforeEach(() => {
  api.setLatency(0);
  api.resetApi();
});
afterEach(() => resetViewerGrants());

describe("refine di una richiesta come conversazione", () => {
  it("«Refine with Claude» apre la conversazione; la richiesta a lato cambia quando Claude scrive", async () => {
    const user = userEvent.setup();
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    const router = renderRoute("/p/STW/requests?request=req-stw-1", "p-laura");
    const panel = await screen.findByRole("region", { name: "Request" });
    await user.click(within(panel).getByRole("button", { name: "Refine with Claude" }));
    await waitFor(() => expect(search(router)).toMatchObject({ request: "req-stw-1", refine: "1" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Refine STW-R1" })).toBeInTheDocument();
    // Una sola richiesta a schermo: il pannello normale lascia il posto al lato.
    expect(screen.queryByRole("region", { name: "Request" })).toBeNull();
    const aside = await side();
    expect(within(aside).getByText("No design yet")).toBeInTheDocument();
    expect(within(aside).getByText("No plan yet")).toBeInTheDocument();

    const box = await screen.findByRole("combobox", { name: "Message to Claude" });
    await user.type(box, "Show the old week too.{Enter}");
    // La riga nel flusso e il campo a lato, dallo stesso evento.
    await waitFor(() =>
      expect(document.querySelector('[data-work-result="design_updated"]')).not.toBeNull(),
    );
    await waitFor(() => expect(within(aside).getByText("Show the old week too.")).toBeInTheDocument());
    await waitFor(() => expect(field("size")).toHaveAttribute("class", expect.stringContaining("claude-touch")));
    expect(field("size")).toHaveTextContent("Updated by Claude · now");
    expect(field("size").querySelector("[data-size]")).toHaveAttribute("data-size", "M");
    expect(within(aside).getAllByText("Updated by Claude · now").length).toBeGreaterThanOrEqual(2);
    expect(request("req-stw-1")).toMatchObject({ status: "refining", size: "M" });
  });

  it("una sessione viva si apre con «Open refinement»; il piano scritto da Claude arriva a lato «Not approved»", async () => {
    const user = userEvent.setup();
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    const router = renderRoute("/p/STW/requests?request=req-stw-4", "p-laura");
    const panel = await screen.findByRole("region", { name: "Request" });
    expect(await within(panel).findByText("Claude is refining this request.")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Refine with Claude" })).toBeNull();
    await user.click(await within(panel).findByRole("button", { name: "Open refinement" }));
    await waitFor(() => expect(search(router).refine).toBe("1"));
    const aside = await side();
    expect(within(aside).getByText(/A direct mention skips the quiet hours/)).toBeInTheDocument();
    // Lo script del seed scrive il piano: arriva a lato, non approvato.
    await waitFor(() =>
      expect(within(aside).getByText(/The push sender checks the quiet hours/)).toBeInTheDocument(),
    );
    expect(within(aside).getByText("Not approved")).toBeInTheDocument();
    // Nessuna sessione nuova: è la stessa.
    expect(state.conversations.filter((c) => c.kind === "refine" && c.requestId === "req-stw-4")).toHaveLength(1);
  });

  it("«See» porta il lato sulla sezione scritta; sotto 1200 px il lato si apre dal bottone, che dice «Updated»", async () => {
    const user = userEvent.setup();
    renderRoute("/p/STW/requests?request=req-stw-1&refine=1", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Refine with Claude" }));
    const box = await screen.findByRole("combobox", { name: "Message to Claude" });
    expect(screen.queryByRole("dialog", { name: "Request STW-R1" })).toBeNull();
    await user.type(box, "Per person.{Enter}");
    const toggle = screen.getByRole("button", { name: /^Request STW-R1/ });
    await waitFor(() => expect(toggle).toHaveTextContent("Updated"));
    const row = await waitFor(() => {
      const el = document.querySelector('[data-work-result="design_updated"]');
      if (!el) throw new Error("no row");
      return el as HTMLElement;
    });
    await user.click(within(row).getByRole("button", { name: "See" }));
    const aside = await sideOverlay();
    expect(toggle).not.toHaveTextContent("Updated");
    const design = aside.querySelector('[data-refine-section="design"]') as HTMLElement;
    expect(design.querySelector(".claude-touch")).not.toBeNull();
    expect(design).toHaveTextContent("Per person.");
    // Esc chiude il lato sovrapposto, non il refine.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Request STW-R1" })).toBeNull());
    expect(screen.getByRole("heading", { level: 1, name: "Refine STW-R1" })).toBeInTheDocument();
  });

  it("«Close the session» chiede conferma; chiusa, la casella lascia il posto alla fascia e a «Start a new one»", async () => {
    const user = userEvent.setup();
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/STW/requests?request=req-stw-4&refine=1", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Close the session" }));
    const dialog = await screen.findByRole("dialog", { name: "Close the refinement?" });
    expect(dialog).toHaveTextContent("Claude stops and the request keeps what was written.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.conversations.find((c) => c.id === "cv-refine-stw-4")!.state).not.toBe("finished");

    await user.click(screen.getByRole("button", { name: "Close the session" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Close the refinement?" })).getByRole(
        "button",
        { name: "Close session" },
      ),
    );
    expect(await screen.findByText("This refinement is closed.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Message to Claude" })).toBeNull();
    expect(await screen.findByText(/closed by Laura/)).toBeInTheDocument();
    expect(request("req-stw-4").status).toBe("ready");
    expect(screen.queryByRole("button", { name: "Close the session" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Start a new one" }));
    await waitFor(() =>
      expect(
        state.conversations.filter(
          (c) => c.kind === "refine" && c.requestId === "req-stw-4" && c.state !== "finished",
        ),
      ).toHaveLength(1),
    );
    expect(await screen.findByRole("combobox", { name: "Message to Claude" })).toBeInTheDocument();
  });

  it("«Close the session» non riuscito: lo dice, e la sessione resta aperta", async () => {
    const user = userEvent.setup();
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/STW/requests?request=req-stw-4&refine=1", "p-laura");
    api.failNext("closeRefine");
    await user.click(await screen.findByRole("button", { name: "Close the session" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Close the refinement?" })).getByRole(
        "button",
        { name: "Close session" },
      ),
    );
    expect(await screen.findByText("Couldn't close the session. It is still open.")).toBeInTheDocument();
    expect(state.conversations.find((c) => c.id === "cv-refine-stw-4")!.state).not.toBe("finished");
  });

  it("archiviata altrove mentre è viva: la sessione si chiude e la vista lo dice", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/STW/requests?request=req-stw-4&refine=1", "p-laura");
    await screen.findByRole("combobox", { name: "Message to Claude" });
    await act(async () => {
      await as("p-roberta", () => api.archiveRequest("req-stw-4"));
    });
    expect(
      await screen.findByText(
        "The request was turned into a task or archived: this refinement is closed.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Closed: the request was turned into a task or archived"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start a new one" })).toBeNull();
    const aside = await side();
    expect(within(aside).getByText("Archived")).toBeInTheDocument();
  });

  it("Sara (senza backlog.edit): né «Refine» né «Open refinement»; il refine non si apre", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/STW/requests?request=req-stw-4", "p-sara");
    const panel = await screen.findByRole("region", { name: "Request" });
    expect(
      await within(panel).findByText(
        "Being refined with Claude. Only people who can edit requests in STW can follow the conversation.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Refine with Claude" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Open refinement" })).toBeNull();
    // Il design scritto nel refine si legge lo stesso, nel pannello della richiesta.
    expect(within(panel).getByText(/A direct mention skips the quiet hours/)).toBeInTheDocument();
  });

  it("Sara sull'indirizzo del refine: legge la richiesta, non la conversazione, e non può scrivere", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    renderRoute("/p/STW/requests?request=req-stw-4&refine=1", "p-sara");
    expect(
      await screen.findByText("Only people who can edit requests in STW can follow the refinement."),
    ).toBeInTheDocument();
    const aside = await side();
    expect(within(aside).getByText(/A direct mention skips the quiet hours/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Message to Claude" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close the session" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refine with Claude" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start a new one" })).toBeNull();
  });

  it("«← Requests» torna all'elenco con la richiesta aperta; la sessione resta viva", async () => {
    const user = userEvent.setup();
    setMatchMedia(DOCKED_PANEL_QUERY, true);
    const router = renderRoute("/p/STW/requests?request=req-stw-4&refine=1", "p-laura");
    await user.click(await screen.findByRole("button", { name: "Requests" }));
    await waitFor(() => expect(search(router).refine).toBeUndefined());
    expect(search(router).request).toBe("req-stw-4");
    expect(await screen.findByRole("heading", { level: 1, name: "Requests" })).toBeInTheDocument();
    expect(state.conversations.find((c) => c.id === "cv-refine-stw-4")!.state).not.toBe("finished");
  });
});
