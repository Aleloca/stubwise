import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failNext, resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { grantProjectRole, resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { expectNoDeploy } from "../../test/noDeploy";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { PR_PANEL_DOCKED_QUERY } from "./PrPanel";

// La sezione Releases (Task 8 del piano 8a, shape releases.md): una lista di
// PR a due gruppi, il merge a due tempi con ogni errore in parole, il
// pannello della PR, gli ambienti. Le prove sul dettaglio di un rilascio
// stanno in `ReleaseDetail.test.tsx`.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  setMatchMedia(PR_PANEL_DOCKED_QUERY, true);
});
afterEach(() => {
  resetViewerGrants();
  act(() => setLanguage("en"));
});

const pr = (id: string) => state.openPrs.find((p) => p.id === id)!;
const group = (name: string) => screen.getByRole("list", { name });
const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-pr-row="${id}"]`)!;

async function openSection(person = "p-laura", path = "/p/AUD/releases") {
  const router = renderRoute(path, person);
  await screen.findByRole("heading", { level: 1, name: "Releases" });
  await screen.findByRole("list", { name: "Ready to release" });
  return router;
}

describe("Releases — la sezione", () => {
  it("una lista sola in due gruppi: #244 pronta con «Release», le altre non pronte col motivo", async () => {
    await openSection();
    expect(screen.getByText(/Stubwise merges, the pipeline releases\./)).toBeInTheDocument();
    const ready = group("Ready to release");
    expect(within(ready).getAllByRole("listitem")).toHaveLength(1);
    expect(rowOf("opr-aud-244")).toBeInTheDocument();
    expect(
      within(rowOf("opr-aud-244")).getByRole("button", { name: "Release audin-app#244" }),
    ).toBeInTheDocument();
    const notReady = group("Not ready yet");
    // #246 col motivo in parola, prima voce della seconda riga.
    expect(
      within(notReady).getByRole("link", { name: /^audin-app#246, .*checks running/ }),
    ).toBeInTheDocument();
    // Nessun «Release» fra le non pronte.
    expect(within(notReady).queryByRole("button", { name: /^Release/ })).toBeNull();
  });

  it("la PR del collega e quella di Claude hanno la stessa riga: solo «by <nome>», nessun «Adopt»", async () => {
    await openSection();
    const colleague = within(rowOf("opr-aud-246")).getByRole("link");
    const claude = within(rowOf("opr-aud-244")).getByRole("link");
    expect(colleague).toHaveAccessibleName(/by Marco Bellini/);
    expect(claude).toHaveAccessibleName(/by Claude/);
    expect(rowOf("opr-aud-246").className).toBe(rowOf("opr-aud-244").className);
    expect(screen.queryByText(/adopt/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /adopt|adotta/i })).toBeNull();
    // Il codice della task collegata, accanto all'autore, come per Claude.
    expect(within(rowOf("opr-aud-244")).getByText("AUD-2")).toBeInTheDocument();
  });

  it("Marco non vede «Release»: la frase una volta sotto il gruppo, non per riga", async () => {
    await openSection("p-marco");
    expect(screen.queryByRole("button", { name: /^Release /i })).toBeNull();
    expect(screen.getAllByText("Someone who can release in AUD can merge it.")).toHaveLength(1);
  });

  it("conferma a due tempi: frase, fuoco su «Confirm merge», Esc annulla; il merge la segue come AUD-V4", async () => {
    await openSection();
    await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
    const confirm = screen.getByRole("button", { name: "Confirm merge" });
    expect(confirm).toHaveFocus();
    expect(
      screen.getByText(
        "Merge #244 into main? The pipeline will release it; Stubwise only follows it.",
      ),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Confirm merge" })).toBeNull();
    // Nessun merge è partito.
    expect(pr("opr-aud-244").state).toBe("open");

    await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(await screen.findByText("Merged. Following it as AUD-V4")).toBeInTheDocument();
    expect(pr("opr-aud-244").state).toBe("merged");
    await waitFor(() => expect(rowOf("opr-aud-244")).toBeNull());
    expect(
      await screen.findByRole("link", { name: /^AUD-V4, Onboarding checklist/ }),
    ).toBeInTheDocument();
  });

  it("il secondo tempo si richiude quando il fuoco esce dalla riga", async () => {
    await openSection();
    await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
    const confirm = screen.getByRole("button", { name: "Confirm merge" });
    fireEvent.blur(confirm, { relatedTarget: screen.getByRole("heading", { level: 1 }) });
    expect(screen.queryByRole("button", { name: "Confirm merge" })).toBeNull();
  });

  it.each<[string, (id: string) => void, string]>([
    [
      "checks_failed",
      (id) => (pr(id).checks = "failing"),
      "Checks are failing on this pull request, so it can't be released.",
    ],
    [
      "checks_unreadable",
      (id) => (pr(id).checks = "unreadable"),
      "Couldn't read the checks on GitHub. Try again in a moment.",
    ],
    [
      "not_mergeable",
      (id) => (pr(id).mergeable = false),
      "GitHub refused the merge: conflicts or branch rules not met.",
    ],
    [
      "merge_forbidden",
      (id) => (pr(id).platformMergeForbidden = true),
      "The git account saved for AUD can't merge this pull request.",
    ],
    [
      "forbidden",
      () => grantProjectRole("p-laura", "prj-aud", "developer"),
      "You can't release in AUD any more.",
    ],
  ])("errore della coda «%s» in parole, la riga resta espansa", async (_code, breakIt, message) => {
    await openSection();
    await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
    breakIt("opr-aud-244");
    await act(async () => {
      await Promise.resolve();
    });
    await userEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    // La riga resta, col secondo tempo aperto; nessun rilascio nuovo.
    await waitFor(() => expect(rowOf("opr-aud-244")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Confirm merge" })).toBeInTheDocument();
    expect(state.releases.some((r) => r.code === "AUD-V4")).toBe(false);
  });

  it.each<[string, (id: string) => void, string]>([
    ["already_closed", (id) => (pr(id).state = "closed"), "This pull request isn't open any more."],
    [
      "not_found",
      (id) => (state.openPrs = state.openPrs.filter((p) => p.id !== id)),
      "This pull request wasn't found.",
    ],
  ])(
    "errore «%s»: la riga si aggiorna da sola e l'errore resta in un avviso",
    async (_code, breakIt, message) => {
      await openSection();
      await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
      breakIt("opr-aud-244");
      await userEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
      expect(await screen.findByText(message)).toBeInTheDocument();
      await waitFor(() => expect(rowOf("opr-aud-244")).toBeNull());
    },
  );

  it("titolo lunghissimo: una riga con ellissi e il titolo intero al passaggio", async () => {
    const long = `Saved filters ${"with a very long explanation ".repeat(9)}`.slice(0, 250);
    pr("opr-aud-246").title = long;
    await openSection();
    const title = within(rowOf("opr-aud-246")).getByText(long);
    expect(title).toHaveClass("truncate");
    expect(title).toHaveAttribute("title", long);
  });

  it("nessun «Deploy» né «Riprova la pipeline» nella sezione, in inglese e in italiano", async () => {
    await openSection();
    expectNoDeploy();
    act(() => setLanguage("it"));
    await screen.findByRole("heading", { level: 1, name: "Rilasci" });
    expectNoDeploy();
  });
});

describe("Releases — il pannello di una PR", () => {
  it("si apre dalla riga: analisi intera, «Written by Claude», correzioni col contatore", async () => {
    const router = await openSection("p-marco");
    await userEvent.click(within(rowOf("opr-aud-246")).getByRole("link"));
    const panel = await screen.findByRole("region", { name: "Pull request audin-app#246" });
    expect(router.state.location.search).toMatchObject({ pr: "opr-aud-246" });
    expect(within(panel).getByText("Written by Claude")).toBeInTheDocument();
    expect(within(panel).getByText(/of 3 automatic corrections used/)).toBeInTheDocument();
    expect(within(panel).getByRole("switch", { name: "Analysis only" })).toBeEnabled();
    expectNoDeploy();
  });

  it("a 1024 il pannello si aggancia accanto alla lista, non la copre (shape §6)", async () => {
    setMatchMedia(DOCKED_PANEL_QUERY, false);
    setMatchMedia(PR_PANEL_DOCKED_QUERY, true);
    await openSection("p-marco", "/p/AUD/releases?pr=opr-aud-246");
    const panel = await screen.findByRole("region", { name: "Pull request audin-app#246" });
    expect(panel.closest("[data-mode]")).toHaveAttribute("data-mode", "docked");
  });

  it("40 problemi: i primi 8 e «Show all 40», poi tutti leggibili", async () => {
    pr("opr-aud-246").analysis!.issues = Array.from({ length: 40 }, (_, i) => ({
      title: `Problem number ${i + 1} ${"with a long description ".repeat(4)}`,
      file: i % 2 ? `src/file-${i}.ts` : null,
    }));
    renderRoute("/p/AUD/releases?pr=opr-aud-246", "p-laura");
    const panel = await screen.findByRole("region", { name: "Pull request audin-app#246" });
    const list = within(panel).getByRole("list", { name: "Problems" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    await userEvent.click(within(panel).getByRole("button", { name: "Show all 40" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(40);
  });

  it("un `?pr=` sconosciuto chiude il pannello senza errore", async () => {
    const router = renderRoute("/p/AUD/releases?pr=opr-nope", "p-laura");
    await screen.findByRole("heading", { level: 1, name: "Releases" });
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("pr"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ogni «Simula» sta nel riquadro «Prototype only»", async () => {
    renderRoute("/p/AUD/releases?pr=opr-aud-246", "p-laura");
    const panel = await screen.findByRole("region", { name: "Pull request audin-app#246" });
    const simulate = within(panel).getAllByRole("button", { name: /^(Simulate|Advance)/ });
    expect(simulate.length).toBeGreaterThan(0);
    for (const b of simulate) expect(b.closest("[data-prototype-only]")).not.toBeNull();
    expect(within(panel).getByText("Prototype only")).toBeInTheDocument();
  });
});

describe("Releases — giro di correzioni 1", () => {
  it("[R 6] la voce Releases della colonna: il conteggio delle PR aperte, il punto solo per chi aspetta", async () => {
    await openSection();
    const item = () => document.querySelector<HTMLElement>('[data-section="releases"]')!;
    await waitFor(() => expect(item()).toHaveTextContent("5"));
    // Laura ha fatto il merge di AUD-V3, fallito e senza riparazione.
    expect(item().querySelector("[data-waiting-dot]")).not.toBeNull();
    expect(within(item()).getByText("A failed release waits on you")).toBeInTheDocument();
    document.body.innerHTML = "";
    await openSection("p-marco");
    await waitFor(() => expect(item()).toHaveTextContent("5"));
    expect(item().querySelector("[data-waiting-dot]")).toBeNull();
  });

  it("[R 6] riparato con una task, il punto se ne va", async () => {
    state.releases.find((r) => r.code === "AUD-V3")!.fixTaskId = "t-aud-3";
    await openSection();
    const item = document.querySelector<HTMLElement>('[data-section="releases"]')!;
    await waitFor(() => expect(item).toHaveTextContent("5"));
    expect(item.querySelector("[data-waiting-dot]")).toBeNull();
  });

  it("m4: se gli ambienti non si leggono, le PR si vedono lo stesso", async () => {
    failNext("releases.listEnvironments");
    await openSection();
    expect(await screen.findByText("Couldn't load the environments.")).toBeInTheDocument();
    expect(rowOf("opr-aud-244")).not.toBeNull();
  });

  it("un'eccezione del merge è un errore generico, non «checks unreadable»", async () => {
    await openSection();
    await userEvent.click(screen.getByRole("button", { name: "Release audin-app#244" }));
    failNext("releases.mergePr");
    await userEvent.click(screen.getByRole("button", { name: "Confirm merge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't merge. Try again in a moment.",
    );
    expect(screen.queryByText(/Couldn't read the checks/)).toBeNull();
  });

  it("m3: «Request changes» anche su una PR di Stubwise, con la sessione della task", async () => {
    const router = renderRoute("/p/AUD/releases?pr=opr-aud-244", "p-marco");
    const panel = await screen.findByRole("region", { name: "Pull request audin-app#244" });
    const before = state.conversations.length;
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "What should change" }),
      "Rename the first step",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Send to Claude" }));
    await waitFor(() => expect(state.conversations.length).toBe(before + 1));
    expect(state.conversations.at(-1)).toMatchObject({
      kind: "task_run",
      taskId: pr("opr-aud-244").taskId,
    });
    // n2: l'esito porta alla sessione appena nata.
    const session = state.conversations.at(-1)!.id;
    await userEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/claude/${session}`));
  });

  it("m3: al tetto (STW guide#58) Marco ha il bottone spento col perché", async () => {
    renderRoute("/p/STW/releases?pr=opr-stw-guide-58", "p-marco");
    const panel = await screen.findByRole("region", { name: "Pull request guide#58" });
    expect(within(panel).getByRole("button", { name: "Send to Claude" })).toBeDisabled();
    expect(
      within(panel).getByText(/Claude reached the limit of 3 corrections\./),
    ).toBeInTheDocument();
  });
});

describe("Releases — ambienti", () => {
  it("con environments.manage: aggiungere, e una sola produzione per progetto", async () => {
    await openSection();
    const part = screen.getByRole("region", { name: /^Environments/ });
    expect(within(part).getByText(/runs f2a4c6e · = AUD-V2/)).toBeInTheDocument();
    await userEvent.click(within(part).getByRole("button", { name: "Add environment" }));
    const dialog = await screen.findByRole("dialog", { name: "Add environment" });
    expect(within(dialog).getByRole("radio", { name: "Production" })).toBeDisabled();
    expect(
      within(dialog).getByText("Production is already the production environment of this project."),
    ).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Preview");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Test" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.environments.some((e) => e.name === "Preview" && e.kind === "test")).toBe(true);
  });

  it("senza environments.manage (Elena, Legacy Member): sola lettura", async () => {
    await openSection("p-elena");
    const part = screen.getByRole("region", { name: /^Environments/ });
    expect(within(part).queryByRole("button", { name: "Add environment" })).toBeNull();
    expect(within(part).queryByRole("button", { name: /^More for/ })).toBeNull();
  });
});
