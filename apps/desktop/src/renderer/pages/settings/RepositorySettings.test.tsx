import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { renderRoute } from "../../test/renderRoute";

// Progetto → Settings → Repositories (Task 8, shape releases.md §6): le
// scelte si salvano subito, «Saved» solo a salvataggio confermato; una
// correzione in volo chiede conferma prima di fermarsi; senza
// `repos.manage` gli stessi valori come frasi.

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

const repo = () => state.repositories.find((r) => r.id === "repo-aud")!;

async function openSettings(person: string) {
  renderRoute("/p/AUD/settings/repositories", person);
  const section = await screen.findByRole("region", { name: "Repositories" });
  return await waitFor(() => {
    const block = section.querySelector<HTMLElement>('[data-repository="audin/audin-app"]');
    expect(block).not.toBeNull();
    return block!;
  });
}

describe("Settings — Repositories", () => {
  it("cambiare il modo salva subito; «Saved» solo dopo, e sparisce alla modifica successiva", async () => {
    setLatency(30);
    const block = await openSettings("p-laura");
    const colleagues = within(block).getByRole("group", { name: /Colleagues' pull requests/ });
    await userEvent.click(within(colleagues).getByRole("radio", { name: /^Analysis only/ }));
    expect(within(colleagues).queryByText("Saved")).toBeNull();
    expect(await within(colleagues).findByText("Saved")).toBeInTheDocument();
    expect(repo().colleaguePrs).toBe("analyze_only");
    await userEvent.click(within(colleagues).getByRole("radio", { name: /^Analysis and fixes/ }));
    expect(within(colleagues).queryByText("Saved")).toBeNull();
    expect(await within(colleagues).findByText("Saved")).toBeInTheDocument();
  });

  it("con una correzione in volo, «Off» chiede conferma e «Cancel» non cambia niente", async () => {
    const pr = state.openPrs.find((p) => p.id === "opr-aud-246")!;
    pr.corrections.push({
      ...pr.corrections[0]!,
      id: "pcor-live",
      state: "running",
      commitSha: null,
    });
    const block = await openSettings("p-laura");
    await userEvent.click(within(block).getByRole("radio", { name: /^Off/ }));
    const dialog = await screen.findByRole("dialog", { name: "Stop the correction in progress?" });
    expect(
      within(dialog).getByText("1 correction in progress on #246 will stop before pushing."),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(repo().colleaguePrs ?? "analyze_and_fix").toBe("analyze_and_fix");
    await userEvent.click(within(block).getByRole("radio", { name: /^Off/ }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Change" }),
    );
    await waitFor(() => expect(repo().colleaguePrs).toBe("off"));
    expect(pr.corrections.find((c) => c.id === "pcor-live")!.state).toBe("stopped");
  });

  it("«Only these»: un elenco vuoto non si salva, un nome sì; il ramo si salva all'uscita", async () => {
    const block = await openSettings("p-laura");
    await userEvent.click(within(block).getByRole("radio", { name: /^Only these/ }));
    expect(within(block).getByText(/an empty list can't be saved/)).toBeInTheDocument();
    expect(repo().releasePipeline?.mode ?? "auto").toBe("auto");
    await userEvent.type(
      within(block).getByRole("textbox", { name: "Workflow or pipeline names" }),
      "CI{Enter}",
    );
    await waitFor(() => expect(repo().releasePipeline).toEqual({ mode: "named", names: ["CI"] }));
    const branch = within(block).getByRole("textbox", { name: "Release branch" });
    await userEvent.clear(branch);
    await userEvent.type(branch, "release");
    await userEvent.tab();
    await waitFor(() => expect(repo().releaseBranch).toBe("release"));
  });

  it("senza repos.manage (Elena): gli stessi valori come frasi, nessun controllo", async () => {
    const block = await openSettings("p-elena");
    expect(within(block).queryByRole("radio")).toBeNull();
    expect(within(block).queryByRole("textbox")).toBeNull();
    expect(within(block).getByText("Analysis and fixes")).toBeInTheDocument();
    expect(within(block).getByText("main")).toBeInTheDocument();
  });
});
