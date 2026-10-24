import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { clearDrafts, readDraft } from "./drafts";

// Il pannello del thread (Task 5): `?thread=<radice>` sopra il canale.

/** Il thread «Billing emails (AUD-4)» del general di AUD (con la risposta di Claude del seme, chiamata da Marco). */
const BILLING = "ch-aud-general-m17";
const SEED_REPLY = "ch-aud-general-m17-r3";

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(0);
  api.resetApi();
  clearDrafts();
});

const at = (personId: string, thread = BILLING, channel = "ch-aud-general") =>
  renderRoute(`/chat/${channel}?thread=${thread}`, personId);
const panel = () => screen.findByRole("region", { name: "Thread" });
const searchOf = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as { thread?: string };
const replyBox = (root: HTMLElement) => within(root).getByRole("combobox", { name: "Reply…" });
/** La risposta di Claude chiamata da `name`, l'ultima del pannello. */
const claudeBy = (root: HTMLElement, name: string) =>
  within(root)
    .getAllByRole("article", { name: `called by ${name}` })
    .at(-1)!;

async function call(root: HTMLElement, text: string) {
  const user = userEvent.setup();
  await user.type(replyBox(root), text);
  await user.keyboard("{Enter}");
}

describe("ThreadPanel: aprire e chiudere", () => {
  beforeEach(() => setMatchMedia(DOCKED_PANEL_QUERY, true));

  it("si apre agganciato su ?thread: radice, conteggio, risposte; × lo chiude e lascia il canale", async () => {
    const router = at("p-giulia");
    const root = await panel();
    expect(root.closest("[data-detail-panel]")?.getAttribute("data-mode")).toBe("docked");
    expect(within(root).getByRole("link", { name: "in AUD · general" })).toHaveAttribute(
      "href",
      "#/chat/ch-aud-general",
    );
    await waitFor(() => expect(root.querySelector(`[data-message="${BILLING}"]`)).not.toBeNull());
    expect(root.querySelector("[data-thread-count]")?.textContent).toMatch(/^\d+ repl(y|ies)$/);
    expect(root.querySelector(`[data-message="${SEED_REPLY}"]`)).not.toBeNull();
    // Nel canale la radice prende la tinta di selezione finché il pannello è aperto.
    const flow = await screen.findByRole("log", { name: "Messages in AUD · general" });
    await waitFor(() =>
      expect(flow.querySelector(`[data-message="${BILLING}"]`)?.hasAttribute("data-selected")).toBe(
        true,
      ),
    );

    await userEvent.click(within(root).getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Thread" })).toBeNull());
    expect(searchOf(router).thread).toBeUndefined();
    expect(flow.querySelector(`[data-message="${BILLING}"]`)?.hasAttribute("data-selected")).toBe(
      false,
    );
  });

  it("un thread che non c'è non si apre: toast e il parametro va via", async () => {
    const router = at("p-giulia", "ch-aud-general-nope");
    expect(await screen.findByText("This thread doesn't exist or you can't see it")).toBeVisible();
    await waitFor(() => expect(searchOf(router).thread).toBeUndefined());
    expect(screen.queryByRole("region", { name: "Thread" })).toBeNull();
  });

  it("cambiare persona chiude il pannello e ne perde la bozza (Review Focus 2)", async () => {
    const router = at("p-giulia");
    const root = await panel();
    await userEvent.type(replyBox(root), "half a thought");
    expect(readDraft("p-giulia", `thread:${BILLING}`)).toBe("half a thought");

    await userEvent.click(screen.getByRole("button", { name: "Profile and settings" }));
    const menu = await screen.findByRole("dialog", { name: "Profile and settings" });
    await userEvent.click(within(menu).getByRole("radio", { name: /Marco Bellini/ }));

    await waitFor(() => expect(searchOf(router).thread).toBeUndefined());
    expect(screen.queryByRole("region", { name: "Thread" })).toBeNull();
    expect(screen.queryByText("half a thought")).toBeNull();
    expect(readDraft("p-giulia", `thread:${BILLING}`)).toBe("");
  });

  it("sotto 1200px è sovrapposto, con il velo: un clic sul velo chiude", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    const router = at("p-giulia");
    const root = await screen.findByRole("dialog", { name: "Thread" });
    expect(root.getAttribute("data-mode")).toBe("overlay");
    await userEvent.click(document.querySelector<HTMLElement>("[data-thread-scrim]")!);
    await waitFor(() => expect(searchOf(router).thread).toBeUndefined());
  });
});

describe("ThreadPanel: rispondere", () => {
  beforeEach(() => setMatchMedia(DOCKED_PANEL_QUERY, true));

  it("«Also send to …» manda la risposta anche nel canale, e si rispegne dopo l'invio", async () => {
    at("p-giulia");
    const root = await panel();
    const user = userEvent.setup();
    const also = within(root).getByRole("checkbox", { name: "Also send to AUD · general" });
    expect(also).not.toBeChecked();
    await user.click(also);
    await call(root, "Attaching it is fine by me");

    await waitFor(() =>
      expect(within(root).getByText("Attaching it is fine by me")).toBeInTheDocument(),
    );
    const flow = screen.getByRole("log", { name: "Messages in AUD · general" });
    await waitFor(() =>
      expect(within(flow).getByText("Attaching it is fine by me")).toBeInTheDocument(),
    );
    expect(flow.querySelector("[data-replied-to-thread]")).not.toBeNull();
    expect(also).not.toBeChecked();
  });

  it("«@Claude» scritto nel canale: per chi l'ha chiamato il pannello si apre da solo su quel thread", async () => {
    const router = renderRoute("/chat/ch-aud-general", "p-giulia");
    const box = await screen.findByRole("combobox", { name: "Message AUD · general" });
    const user = userEvent.setup();
    await user.type(box, "@Claude explain AUD-4");
    await user.keyboard("{Enter}");
    const root = await panel();
    const call = state.chatMessages.find(
      (m) => m.authorId === "p-giulia" && m.text === "@Claude explain AUD-4",
    )!;
    expect(searchOf(router).thread).toBe(call.id);
    await waitFor(() => expect(claudeBy(root, "Giulia Ferri")).toBeInTheDocument());
  });

  it("scrivendo «@Claude» compare l'avviso: agirà come te, visibile a tutti nel canale", async () => {
    at("p-giulia");
    const root = await panel();
    await userEvent.type(replyBox(root), "@Claude explain AUD-4");
    expect(
      within(root).getByText(
        "Claude will act as you and reply here, visible to everyone in AUD · general.",
      ),
    ).toBeInTheDocument();
  });
});

describe("ThreadPanel: @Claude", () => {
  beforeEach(() => setMatchMedia(DOCKED_PANEL_QUERY, true));

  it("la risposta di Claude arriva dal vivo, «called by» chi l'ha chiamata; Stop solo per lei", async () => {
    api.setStreamLatency(15);
    at("p-giulia");
    const root = await panel();
    await call(root, "@Claude explain AUD-4");
    const reply = await waitFor(() => claudeBy(root, "Giulia Ferri"));
    expect(reply.getAttribute("data-claude-reply")).toBe("working");
    expect(within(reply).getByText("called by Giulia Ferri")).toBeInTheDocument();
    expect(within(reply).getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await waitFor(() => expect(reply.getAttribute("data-claude-reply")).toBe("done"), {
      timeout: 4000,
    });
    expect(reply.textContent).toContain("Billing emails");
    expect(within(reply).queryByRole("button", { name: "Stop" })).toBeNull();
    await waitFor(() =>
      expect(root.querySelector("[data-thread-announce]")?.textContent).toBe("Claude replied"),
    );
  });

  it("due chiamanti: ognuno vede i bottoni solo sulla propria proposta (Review Focus 4)", async () => {
    at("p-giulia");
    const root = await panel();
    await call(root, '@Claude create "Invoice size check" in AUD');
    const mine = await waitFor(
      () => {
        const r = claudeBy(root, "Giulia Ferri");
        expect(r.getAttribute("data-claude-reply")).toBe("done");
        return r;
      },
      { timeout: 4000 },
    );
    expect(within(mine).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    // La proposta del seme è di Marco: Giulia la legge, senza bottoni.
    const marcos = root.querySelector<HTMLElement>(`[data-message="${SEED_REPLY}"]`)!;
    expect(within(marcos).getByText("Proposal for Marco Bellini")).toBeInTheDocument();
    expect(within(marcos).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(marcos).queryByRole("button", { name: "Cancel" })).toBeNull();

    await userEvent.click(within(mine).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(within(mine).getByText("Done")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(state.tasks.some((t) => t.title === "Invoice size check")).toBe(true);
  });

  it("la proposta di Giulia, vista da Marco: «Proposal for Giulia Ferri», nessun bottone", async () => {
    setSessionPersonId("p-giulia");
    await api.chat.sendMessage("ch-aud-general", {
      text: "@Claude plan it for W45",
      threadOf: BILLING,
    });
    const reply = state.chatMessages.filter((m) => m.calledById === "p-giulia").at(-1)!;
    await api.chat.whenClaudeIdle(reply.id);

    at("p-marco");
    const root = await panel();
    const hers = await waitFor(() => claudeBy(root, "Giulia Ferri"));
    expect(within(hers).getByText("Proposal for Giulia Ferri")).toBeInTheDocument();
    expect(within(hers).queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(within(hers).queryByRole("button", { name: "Stop" })).toBeNull();
    // La sua (del seme) invece è confermabile.
    const his = root.querySelector<HTMLElement>(`[data-message="${SEED_REPLY}"]`)!;
    expect(within(his).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("la domanda di Claude: risponde solo chi ha chiamato, e la risposta continua (R-G4)", async () => {
    at("p-giulia");
    const root = await panel();
    await call(root, "@Claude assign AUD-4");
    const reply = await waitFor(
      () => {
        const r = claudeBy(root, "Giulia Ferri");
        expect(r.getAttribute("data-claude-reply")).toBe("waiting");
        return r;
      },
      { timeout: 4000 },
    );
    const card = within(reply).getByRole("region", { name: "Claude asks you" });
    expect(card.textContent).toContain("Who should take AUD-4");
    await userEvent.click(within(card).getByRole("button", { name: /Matteo Conti/ }));
    await waitFor(() => expect(reply.getAttribute("data-claude-reply")).toBe("done"), {
      timeout: 4000,
    });
    expect(within(reply).getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(await api.chat.listClaudeQuestions()).toEqual([]);
  });

  it("chi non ha chiamato legge la domanda e «Waiting for …», senza poter rispondere", async () => {
    setSessionPersonId("p-giulia");
    await api.chat.sendMessage("ch-aud-general", {
      text: "@Claude assign AUD-4",
      threadOf: BILLING,
    });
    const reply = state.chatMessages.filter((m) => m.calledById === "p-giulia").at(-1)!;
    await api.chat.whenClaudeIdle(reply.id);

    at("p-marco");
    const root = await panel();
    const hers = await waitFor(() => claudeBy(root, "Giulia Ferri"));
    const card = within(hers).getByRole("region", { name: "Claude asks Giulia Ferri" });
    expect(within(card).getByText("Waiting for Giulia Ferri")).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("una risposta fallita: il motivo nella lingua di chi guarda e «Try again» solo per chi ha chiamato", async () => {
    api.failNext("chat.claudeReply");
    at("p-giulia");
    const root = await panel();
    await call(root, "@Claude explain AUD-4");
    const reply = await waitFor(
      () => {
        const r = claudeBy(root, "Giulia Ferri");
        expect(r.getAttribute("data-claude-reply")).toBe("failed");
        return r;
      },
      { timeout: 4000 },
    );
    expect(within(reply).getByText("Claude couldn't finish: something went wrong")).toBeVisible();
    expect(reply.textContent).not.toContain("Simulated");
    await userEvent.click(within(reply).getByRole("button", { name: "Try again" }));
    await waitFor(
      () =>
        expect(
          within(root)
            .getAllByRole("article", { name: "called by Giulia Ferri" })
            .some((r) => r.getAttribute("data-claude-reply") === "done"),
        ).toBe(true),
      { timeout: 4000 },
    );
  });

  it("chi non vede il progetto legge il codice tenue senza il nome, nelle schede e nelle righe (R-E9)", async () => {
    setSessionPersonId("p-giulia");
    const sent = await api.chat.sendMessage("ch-announcements", {
      text: "@Claude plan AUD-4 for W45",
    });
    const reply = state.chatMessages.filter((m) => m.calledById === "p-giulia").at(-1)!;
    await api.chat.whenClaudeIdle(reply.id);
    const title = state.tasksById.get("t-aud-4")!.title;

    at("p-sara", sent.id, "ch-announcements");
    const root = await panel();
    const hers = await waitFor(() => claudeBy(root, "Giulia Ferri"));
    const card = hers.querySelector<HTMLElement>("[data-proposal]")!;
    expect(card.textContent).not.toContain(title);
    expect(card.querySelector('[data-citation="hidden"]')?.textContent).toBe("AUD-4");
  });

  it("una risposta di Claude eliminata dice solo «Message deleted»", async () => {
    setSessionPersonId("p-marco");
    await api.chat.deleteMessage(SEED_REPLY);
    at("p-giulia");
    const root = await panel();
    const gone = await waitFor(
      () => root.querySelector<HTMLElement>(`[data-message="${SEED_REPLY}"]`)!,
    );
    expect(gone.textContent).toBe("Message deleted");
  });
});
