import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccount, GoogleWorkspaceChoice } from "../../data/types";
import { renderWithData } from "../../test/renderWithData";
import { closeGoogleAccount, GoogleAccountHost, openGoogleAccount } from "./GoogleAccountCard";

// Il cassetto Google nella build app (area 6). Dalla F5b il Drive Google c'è:
// tornano i testi del prototipo (il rimando della F1), con le cartelle che
// smettono di aggiornarsi scollegando. Una casella senza i permessi nuovi è
// «da ricollegare» senza data, con le funzioni che mancano. Con più
// Workspace utilizzabili «Collega» chiede quale.

const q = vi.hoisted(() => ({
  account: null as GoogleAccount | null,
  workspaces: [] as GoogleWorkspaceChoice[],
  connect: vi.fn(),
  folders: vi.fn(),
  folderList: [] as { id: string; name: string; linkedById: string; projectId: string }[] | undefined,
}));
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useGoogleAccount: () => ({ data: q.account, isPending: false }),
  useGoogleWorkspaces: () => ({ data: q.workspaces }),
  useConnectGoogle: () => ({ mutate: q.connect, isPending: false, isError: false }),
  useDisconnectGoogle: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useMyFolderLinks: (enabled: boolean) => {
    q.folders(enabled);
    return { data: enabled ? q.folderList : undefined };
  },
}));

const connected: GoogleAccount = { personId: "p", email: "ada@acme.test", status: "connected", since: "2026-11-01T09:00:00Z" };

beforeEach(() => {
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
  // Di default il desktop (il ponte del preload): la scheda del web ha i suoi test.
  vi.stubGlobal("stubwise", { api: {} });
  q.account = null;
  q.workspaces = [{ id: "ws-1", name: "Acme", domains: ["acme.test"] }];
  q.connect.mockReset();
  q.folders.mockReset();
  q.folderList = [];
});
afterEach(() => {
  act(() => closeGoogleAccount());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function open() {
  renderWithData(<GoogleAccountHost />);
  act(() => openGoogleAccount());
  return screen.findByRole("dialog", { name: "Google account" });
}

describe("il cassetto Google nella build app", () => {
  it("non collegato: il testo del Drive (F5b) e di Posta e Calendario; un solo Workspace, nessuna domanda", async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent("find your Google Drive files and link folders to projects");
    expect(dialog).toHaveTextContent("Mail and Calendar will use the same account.");
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect Google account" }));
    expect(q.connect).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("web: la scheda del consenso si apre NEL clic (Safari blocca una scheda aperta dopo le richieste)", async () => {
    vi.stubGlobal("stubwise", undefined);
    const tab = {};
    const opened = vi.fn(() => tab);
    vi.stubGlobal("open", opened);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect Google account" }));
    expect(opened).toHaveBeenCalledWith("", "_blank");
    expect(q.connect).toHaveBeenCalledWith({ workspaceId: "ws-1", tab });
  });

  it("desktop: nessuna scheda dal renderer (il link va al browser di sistema)", async () => {
    const opened = vi.fn(() => null);
    vi.stubGlobal("open", opened);
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect Google account" }));
    expect(opened).not.toHaveBeenCalled();
    expect(q.connect).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("più Workspace utilizzabili: si sceglie quale, poi «Collega» usa quello", async () => {
    q.workspaces = [
      { id: "ws-1", name: "Acme", domains: ["acme.test"] },
      { id: "ws-2", name: "Beta", domains: ["beta.test"] },
    ];
    const dialog = await open();
    const group = within(dialog).getByRole("radiogroup", { name: "Google Workspace" });
    await userEvent.click(within(group).getByRole("radio", { name: /Beta/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect Google account" }));
    expect(q.connect).toHaveBeenCalledWith({ workspaceId: "ws-2" });
  });

  it("scaduta: le cartelle collegate non si aggiornano finché non si ricollega (F5b)", async () => {
    q.account = { ...connected, status: "expired", reconnect: "expired", since: "2026-11-10T08:00:00Z" };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Folders you linked don't update until you reconnect.");
    expect(within(dialog).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("senza i permessi nuovi: il titolo senza data, e cosa manca finché non si ricollega", async () => {
    q.account = { ...connected, status: "expired", reconnect: "scopes", missing: ["markRead"] };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Reconnect to give Stubwise the new permissions");
    expect(dialog).not.toHaveTextContent(/expired on/);
    expect(dialog).toHaveTextContent("Until you reconnect, Stubwise can't mark mail as read or unread.");
    expect(within(dialog).getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("«Ricollega» con più Workspace: quello della casella è già scelto", async () => {
    q.workspaces = [
      { id: "ws-1", name: "Acme", domains: ["acme.test"] },
      { id: "ws-2", name: "Beta", domains: ["beta.test"] },
    ];
    q.account = { ...connected, status: "expired", reconnect: "expired", since: "2026-11-10T08:00:00Z", workspaceId: "ws-2" };
    const dialog = await open();
    expect(within(dialog).getByRole("radio", { name: /Beta/ })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    expect(q.connect).toHaveBeenCalledWith({ workspaceId: "ws-2" });
  });

  it("senza funzioni elencate (uno scope di una fetta futura): solo il titolo", async () => {
    q.account = { ...connected, status: "expired", reconnect: "scopes", missing: [] };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Reconnect to give Stubwise the new permissions");
    expect(dialog).not.toHaveTextContent("Until you reconnect");
  });

  it("scollegare: le cartelle che ho collegato smettono di aggiornarsi (F5b), e Posta e Calendario", async () => {
    q.account = connected;
    q.folderList = [{ id: "l-1", name: "Clienti", linkedById: "p", projectId: "prj-1" }];
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(dialog).toHaveTextContent("1 folder you linked will stop updating: Clienti.");
    expect(dialog).toHaveTextContent("Mail and Calendar will stop showing ada@acme.test too.");
    // Le cartelle si leggono solo a scollegamento aperto.
    expect(q.folders.mock.calls.some(([enabled]) => enabled === true)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Disconnect account" })).toBeEnabled();
  });
});
