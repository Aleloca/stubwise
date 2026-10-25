import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import * as api from "../../data/api";
import { state } from "../../data/store";
import type { ChatMessage } from "../../data/types";
import { can, revokeProjectPermission, viewerFor } from "../../data/viewer";
import { clearToasts, ToastRegion } from "../../tasks-ui/Toast";
import { renderWithData } from "../../test/renderWithData";
import { ChannelView } from "./ChannelView";
import { clearDrafts } from "./drafts";

// «Save to Drive» sull'allegato di un messaggio (area 5, chiude la decisione
// aperta dell'area 4): in un canale di progetto salva in quel progetto; in un
// DM o in un canale generale chiede il progetto fra quelli con
// `drive.upload`; senza nessuno l'azione non c'è.

beforeEach(() => {
  api.setLatency(0);
  api.setStreamLatency(null);
  api.resetApi();
  clearDrafts();
  clearToasts();
});

const NAME = "contract-scan-signed.pdf";

function withAttachment(channelId: string): ChatMessage {
  const m: ChatMessage = {
    id: `m-att-${channelId}`,
    channelId,
    createdAt: "2026-10-23T11:00:00Z",
    threadOf: null,
    authorId: "p-marco",
    kind: "person",
    text: "Here is the signed scan",
    attachments: [{ id: `att-${channelId}`, name: NAME, sizeBytes: 812_000, kind: "file" }],
    citations: [],
    reactions: [],
    asksReplyOf: [],
    linkedCodes: [],
    editedAt: null,
    deletedAt: null,
    deletedById: null,
  };
  state.chatMessages.push(m);
  return m;
}

const chip = () =>
  screen.findByText(NAME).then((el) => el.closest("[data-attachment]") as HTMLElement);
const saveButton = (root: HTMLElement) =>
  within(root).queryByRole("button", { name: `Save ${NAME} to the Drive` });
const savedIn = (projectId: string) =>
  state.driveFiles.filter((f) => f.projectId === projectId && f.name === NAME);

function render(channelId: string) {
  return renderWithData(
    <div style={{ height: 800 }}>
      <ChannelView channelId={channelId} />
      <ToastRegion />
    </div>,
    { personId: "p-giulia" },
  );
}

describe("Save to Drive sull'allegato", () => {
  it("in un canale di progetto salva in quel progetto, senza chiedere", async () => {
    withAttachment("ch-aud-general");
    render("ch-aud-general");
    const button = saveButton(await chip());
    expect(button).not.toBeNull();
    await userEvent.click(button!);
    await waitFor(() => expect(savedIn("prj-aud")).toHaveLength(1));
    expect(savedIn("prj-aud")[0]).toMatchObject({ mime: "application/pdf", sizeBytes: 812_000 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(/Saved to the AUD Drive as AUD-F\d+/)).toBeTruthy();
  });

  it("in un DM chiede il progetto fra quelli con drive.upload, e salva lì", async () => {
    withAttachment("dm-giulia-marco");
    render("dm-giulia-marco");
    await userEvent.click(saveButton(await chip())!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toContain(NAME);
    const options = within(dialog).getAllByRole("option");
    const allowed = state.projects.filter((p) => can(viewerFor("p-giulia"), "drive.upload", p.id));
    expect(options).toHaveLength(allowed.length);
    await userEvent.click(within(dialog).getByRole("option", { name: /^AUD/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedIn("prj-aud")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("in un canale generale chiede anche lui; «Not now» non salva nulla", async () => {
    withAttachment("ch-announcements");
    render("ch-announcements");
    await userEvent.click(saveButton(await chip())!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.driveFiles.some((f) => f.name === NAME)).toBe(false);
  });

  it("senza drive.upload in nessun progetto l'azione non c'è (DM e progetto)", async () => {
    for (const p of state.projects) revokeProjectPermission("p-giulia", p.id, "drive.upload");
    withAttachment("dm-giulia-marco");
    const { unmount } = render("dm-giulia-marco");
    const dm = await chip();
    // Le letture sono arrivate (il resto del messaggio c'è): l'azione manca davvero.
    await screen.findByText("Here is the signed scan");
    expect(saveButton(dm)).toBeNull();
    unmount();
    withAttachment("ch-aud-general");
    render("ch-aud-general");
    const project = await chip();
    await screen.findByText("Here is the signed scan");
    expect(saveButton(project)).toBeNull();
  });

  it("in un canale di progetto senza drive.upload lì, l'azione non c'è anche se altrove si può", async () => {
    revokeProjectPermission("p-giulia", "prj-aud", "drive.upload");
    expect(state.projects.some((p) => can(viewerFor("p-giulia"), "drive.upload", p.id))).toBe(true);
    withAttachment("ch-aud-general");
    render("ch-aud-general");
    const project = await chip();
    await screen.findByText("Here is the signed scan");
    expect(saveButton(project)).toBeNull();
  });
});
