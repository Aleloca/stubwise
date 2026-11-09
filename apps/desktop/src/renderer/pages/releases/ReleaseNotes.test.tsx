import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../data/api";
import { releaseNotesDraftFor } from "../../data/releases/notes";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import type { ConversationEvent } from "../../data/types";
import { setLanguage } from "../../i18n";
import { resetPanelToggle } from "../../layout/claudePanel/panelEvents";
import { DOCKED_PANEL_QUERY } from "../../layout/useDetailPanel";
import { expectNoDeploy } from "../../test/noDeploy";
import { renderRoute } from "../../test/renderRoute";
import { setMatchMedia } from "../../test/setup";
import { PR_PANEL_DOCKED_QUERY } from "./PrPanel";

// Le note di rilascio (area 10b, Task 10, S6b; shape `claude-drafts.md`
// §3.7): un campo nel pannello della PR per chi può modificarle, con «Save»
// della persona — una bozza di Claude entra col segno e non si salva da
// sola —; in sola lettura per gli altri, senza «Who?». Dopo il merge il
// dettaglio del rilascio le mostra. Il salvataggio fallito dice «Save again»,
// mai «Retry» (P26).

const LAURA = "p-laura";
const SARA = "p-sara";
const ACQ_PR = "opr-acq-77";
const PR_PATH = `/p/ACQ/releases?pr=${ACQ_PR}`;
const prOf = () => state.openPrs.find((p) => p.id === ACQ_PR)!;
type DraftEvent = Extract<ConversationEvent, { type: "draft" }>;
const draftEvents = (): DraftEvent[] =>
  [...state.conversationEvents.values()].flat().filter((e): e is DraftEvent => e.type === "draft");

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  resetPanelToggle();
  setMatchMedia(DOCKED_PANEL_QUERY, true);
  setMatchMedia(PR_PANEL_DOCKED_QUERY, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => setLanguage("en"));
  setSessionPersonId("p-giulia");
});

const prPanel = () => screen.findByRole("region", { name: "Pull request portale-utenti#77" });
const claude = () => document.getElementById("claude-panel");
const panelOpen = () => claude() !== null && !claude()!.hidden;
const panelBox = () => within(claude()!).getByRole("textbox", { name: "Message to Claude" });
const notes = (root: HTMLElement) =>
  within(root).queryByRole("textbox", { name: "Release notes" }) as HTMLTextAreaElement | null;
const mark = (root: HTMLElement) => root.querySelector("[data-claude-draft-mark]");

async function askPanel(user: ReturnType<typeof userEvent.setup>, text: string) {
  if (!panelOpen()) await user.keyboard("{Control>}j{/Control}");
  await waitFor(() => expect(panelBox()).toHaveFocus());
  await user.type(panelBox(), `${text}{Enter}`);
}

describe("S6b: le note dal riquadro", () => {
  it("nel campo della PR col segno, non salvate; «Save» le salva; dopo il merge il rilascio le mostra", async () => {
    const user = userEvent.setup();
    renderRoute(PR_PATH, LAURA);
    const root = await prPanel();
    const expected = releaseNotesDraftFor(LAURA, ACQ_PR)!;
    await askPanel(user, "write the release notes");
    await waitFor(() => expect(notes(root)?.value).toBe(expected.text));
    expect(mark(root)).toHaveTextContent("Claude's draft");
    expect(mark(root)).toHaveTextContent("edit it before saving");
    for (const code of expected.sources) expect(mark(root)).toHaveTextContent(code);
    await waitFor(() =>
      expect(claude()!.querySelector("[data-draft-row]")).toHaveTextContent(
        "Put a draft in the release notes of ACQ · pull request #77",
      ),
    );
    expect(draftEvents().at(-1)!.status).toBe("placed");
    // Non salvate: una bozza non si salva da sola.
    expect(prOf().releaseNotes).toBeUndefined();

    const save = vi.spyOn(api.releases, "setPrReleaseNotes");
    await user.dblClick(within(root).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(prOf().releaseNotes).toBe(expected.text));
    expect(save).toHaveBeenCalledTimes(1);
    expect(mark(root)).toBeNull();
    expect(within(root).getByText("Saved")).toBeInTheDocument();
    // I1: salvate, la riga non offre più «Undo»; I2: il fuoco torna nell'area, mai sul body.
    const row = claude()!.querySelector<HTMLElement>("[data-draft-row]")!;
    await waitFor(() => expect(draftEvents().at(-1)!.status).toBe("changed_after"));
    expect(within(row).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(row).not.toHaveTextContent("as they were");
    expect(document.activeElement).toBe(notes(root));

    setSessionPersonId(LAURA);
    const merged = await api.releases.mergePr(ACQ_PR);
    if (!merged.ok || !merged.release) throw new Error("merge");
    document.body.replaceChildren();
    renderRoute(`/p/ACQ/releases/${merged.release.code}`, LAURA);
    const section = await screen.findByRole("region", { name: "Release notes" });
    expect(section).toHaveTextContent(expected.text.split("\n")[0]!.replace(/^- /, ""));
    // I codici delle task che Laura vede sono link; nessun campo, nessun segno.
    expect(within(section).getByRole("link", { name: "ACQ-7" })).toBeInTheDocument();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(section.querySelector("[data-claude-draft-mark]")).toBeNull();
  });

  it("con note già scritte la riga chiede «Replace or add below?»", async () => {
    const user = userEvent.setup();
    prOf().releaseNotes = "- Hand-written line";
    renderRoute(PR_PATH, LAURA);
    const root = await prPanel();
    await askPanel(user, "write the release notes");
    const ask = await waitFor(() =>
      within(claude()!.querySelector<HTMLElement>("[data-draft-row]")!).getByRole("group", {
        name: "The release notes already have text. Replace them, or add the draft below?",
      }),
    );
    expect(notes(root)!.value).toBe("- Hand-written line");
    await user.click(within(ask).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(notes(root)!.value).not.toBe("- Hand-written line"));
    expect(prOf().releaseNotes).toBe("- Hand-written line");
  });
});

describe("Il campo delle note", () => {
  it("a mano: «Save» e «Cancel» solo con modifiche; salvato, «Saved»", async () => {
    const user = userEvent.setup();
    renderRoute(PR_PATH, LAURA);
    const root = await prPanel();
    const box = notes(root)!;
    expect(box).toHaveAttribute(
      "placeholder",
      "What changes for the people who use it. One line per task.",
    );
    expect(root).toHaveTextContent("Shown in the release after the merge.");
    expect(within(root).queryByRole("button", { name: "Save" })).toBeNull();
    await user.type(box, "- ACQ-7: Reminder");
    await user.click(within(root).getByRole("button", { name: "Cancel" }));
    expect(box.value).toBe("");
    // I2: i bottoni spariscono, il fuoco torna nell'area.
    expect(document.activeElement).toBe(box);
    await user.type(box, "- ACQ-7: Reminder");
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(prOf().releaseNotes).toBe("- ACQ-7: Reminder"));
    expect(await within(root).findByText("Saved")).toBeInTheDocument();
    expect(mark(root)).toBeNull();
  });

  it("salvataggio fallito: «Couldn't save · Save again», il testo intatto, nessun controllo vietato", async () => {
    const user = userEvent.setup();
    renderRoute(PR_PATH, LAURA);
    const root = await prPanel();
    await user.type(notes(root)!, "- Keep me");
    api.failNext("releases.setPrReleaseNotes");
    await user.click(within(root).getByRole("button", { name: "Save" }));
    const alert = await within(root).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save");
    expect(within(alert).getByRole("button", { name: "Save again" })).toBeInTheDocument();
    expect(notes(root)!.value).toBe("- Keep me");
    expect(prOf().releaseNotes).toBeUndefined();
    expectNoDeploy();
    await user.click(within(alert).getByRole("button", { name: "Save again" }));
    await waitFor(() => expect(prOf().releaseNotes).toBe("- Keep me"));
    expect(document.activeElement).toBe(notes(root));
  });

  it("chi non può modificarle le legge, senza campo né «Who?»", async () => {
    prOf().releaseNotes = "- ACQ-7: Reminder";
    renderRoute(PR_PATH, SARA);
    const root = await prPanel();
    expect(notes(root)).toBeNull();
    expect(root).toHaveTextContent("- ACQ-7: Reminder");
    expect(within(root).queryByRole("button", { name: /who\?/i })).toBeNull();
  });

  it("P14: una vista della PR senza `releaseNotes` né `canEditReleaseNotes` si disegna in sola lettura senza note", async () => {
    const list = api.releases.listOpenPrs;
    vi.spyOn(api.releases, "listOpenPrs").mockImplementation(async (projectId) =>
      (await list(projectId)).map((view) => {
        const old = { ...view } as Partial<typeof view>;
        delete old.releaseNotes;
        delete old.canEditReleaseNotes;
        return old as typeof view;
      }),
    );
    renderRoute(PR_PATH, LAURA);
    const root = await prPanel();
    expect(notes(root)).toBeNull();
    expect(root).toHaveTextContent("No release notes yet.");
  });

  it("P14: un rilascio senza `releaseNotes` non ha la sezione", async () => {
    setSessionPersonId(LAURA);
    const merged = await api.releases.mergePr(ACQ_PR);
    if (!merged.ok || !merged.release) throw new Error("merge");
    const get = api.releases.getRelease;
    vi.spyOn(api.releases, "getRelease").mockImplementation(async (code) => {
      const view = await get(code);
      if (!view) return view;
      const old = { ...view } as Partial<typeof view>;
      delete old.releaseNotes;
      return old as typeof view;
    });
    renderRoute(`/p/ACQ/releases/${merged.release.code}`, LAURA);
    await screen.findByRole("heading", { name: /Runs/ });
    expect(screen.queryByRole("region", { name: "Release notes" })).toBeNull();
  });
});
