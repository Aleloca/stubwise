import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import { state } from "../../data/store";
import { grantProjectRole, resetViewerGrants } from "../../data/viewer";
import { setLanguage } from "../../i18n";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";

// La sezione Releases (Task 8 del piano 8a, shape releases.md): una lista di
// PR a due gruppi, il merge a due tempi con ogni errore in parole, il
// pannello della PR, gli ambienti. Le prove sul dettaglio di un rilascio
// stanno in `ReleaseDetail.test.tsx`.

beforeEach(() => {
  setLatency(0);
  resetApi();
  window.localStorage.clear();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
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

/**
 * Anti-obiettivo 1: nessun controllo che avvii, rilanci o promuova un
 * rilascio o una pipeline. Si cerca per nome accessibile fra bottoni, link
 * e voci di menu, e per testo in tutta la pagina.
 */
function expectNoDeploy() {
  const actions = [
    ...screen.queryAllByRole("button"),
    ...screen.queryAllByRole("link"),
    ...screen.queryAllByRole("menuitem"),
    ...screen.queryAllByRole("switch"),
  ];
  const banned =
    /^(re-?deploy|deploy|re-?run|rerun|retry the pipeline|promote|riprova|rilancia|promuovi)\b/i;
  for (const el of actions) {
    const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    expect(name, `controllo vietato: «${name}»`).not.toMatch(banned);
  }
  // Nessun elemento il cui testo SIA un invito a rilanciare o a rilasciare a
  // mano (la frase-confine del sottotitolo lo nomina solo per negarlo).
  for (const el of document.body.querySelectorAll("*")) {
    expect(el.textContent?.trim() ?? "").not.toMatch(
      /^(deploy|re-?deploy|re-?run( the)? pipeline|riprova la pipeline|rilancia la pipeline)$/i,
    );
  }
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
