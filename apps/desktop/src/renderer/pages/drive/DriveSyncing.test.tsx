import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetApi, setLatency } from "../../data/api";
import type { FolderLinkView } from "../../data/types";
import { renderRoute } from "../../test/renderRoute";

// Review F5b (4): una cartella appena collegata non ha ancora file (li legge
// il worker): resta visibile, e dice che si sta sincronizzando. La cartella
// «in sincronizzazione» la dice il livello dati vero; qui è finta.
const q = vi.hoisted(() => ({ links: [] as FolderLinkView[] }));
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useFolderLinks: () => ({ data: q.links }),
  // «Sync now» nella build app: la richiesta parte, la sincronizzazione la fa il worker.
  useSyncFolder: () => ({
    mutate: (_id: string, o: { onSuccess: (v: FolderLinkView) => void }) =>
      o.onSuccess({ ...q.links[0]!, syncing: true }),
  }),
}));

beforeEach(() => {
  setLatency(0);
  resetApi();
  q.links = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("una cartella in sincronizzazione", () => {
  it("senza file ancora: c'è, e dice «syncing…»", async () => {
    q.links = [
      {
        id: "fl-new",
        projectId: "prj-mkx",
        name: "Nuova cartella",
        googleFolderId: "gf-new",
        linkedById: "p-giulia",
        linkedAt: "2026-11-13T10:00:00.000Z",
        status: "ok",
        expiredAt: null,
        lastSyncedAt: null,
        fileCount: 0,
        accessLost: false,
        syncing: true,
      },
    ];
    renderRoute("/p/MKX/drive", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Drive" });
    await waitFor(() =>
      expect(document.querySelector('[data-drive-folder="fl-new"]')).toHaveTextContent(/syncing…/),
    );
  });

  it("«Sync now» dice che la sincronizzazione è chiesta, non fatta", async () => {
    q.links = [
      {
        id: "fl-mkx-primavera",
        projectId: "prj-mkx",
        name: "MKX – Campagna primavera",
        googleFolderId: "gfolder-mkx-primavera",
        linkedById: "p-giulia",
        linkedAt: "2026-11-01T10:00:00.000Z",
        status: "ok",
        expiredAt: null,
        lastSyncedAt: "2026-11-13T02:00:00.000Z",
        fileCount: 3,
        accessLost: false,
      },
    ];
    renderRoute("/p/MKX/drive", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Drive" });
    await userEvent.click(await screen.findByRole("button", { name: "Actions for MKX – Campagna primavera" }));
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Sync now" }));
    expect(await screen.findByText("Syncing “MKX – Campagna primavera”…")).toBeInTheDocument();
    expect(screen.queryByText("Synced MKX – Campagna primavera")).toBeNull();
  });

  // Review F5b (5, 8): il menu della cartella apre la cartella su Google (nella
  // build app, senza l'avviso del prototipo) e copia il link con l'id codificato.
  it("«Open in Google Drive» e «Copy link» della cartella", async () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    q.links = [
      {
        id: "fl-mkx-primavera",
        projectId: "prj-mkx",
        name: "MKX – Campagna primavera",
        googleFolderId: "gf/1 a",
        linkedById: "p-giulia",
        linkedAt: "2026-11-01T10:00:00.000Z",
        status: "ok",
        expiredAt: null,
        lastSyncedAt: "2026-11-13T02:00:00.000Z",
        fileCount: 3,
        accessLost: false,
      },
    ];
    renderRoute("/p/MKX/drive", "p-giulia");
    await screen.findByRole("heading", { level: 1, name: "Drive" });
    const actions = await screen.findByRole("button", { name: "Actions for MKX – Campagna primavera" });
    await userEvent.click(actions);
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Open in Google Drive" }));
    expect(open).toHaveBeenCalledWith("https://drive.google.com/drive/folders/gf%2F1%20a", "_blank", "noopener");
    await userEvent.click(actions);
    await userEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://drive.google.com/drive/folders/gf%2F1%20a");
  });
});
