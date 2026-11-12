import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccount, GoogleWorkspaceChoice } from "../../data/types";
import { renderWithData } from "../../test/renderWithData";
import { closeGoogleAccount, GoogleAccountHost, openGoogleAccount } from "./GoogleAccountCard";

// Il cassetto Google nella build app (area 6, fetta 1). Il Drive Google è
// spento fino alla F5: i testi parlano di Posta e Calendario (decisione (a)
// dell'orchestratrice). Una casella senza i permessi nuovi è «da
// ricollegare» senza data, con le funzioni che mancano. Con più Workspace
// utilizzabili «Collega» chiede quale.

const q = vi.hoisted(() => ({
  account: null as GoogleAccount | null,
  workspaces: [] as GoogleWorkspaceChoice[],
  connect: vi.fn(),
  folders: vi.fn(),
}));
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useGoogleAccount: () => ({ data: q.account, isPending: false }),
  useGoogleWorkspaces: () => ({ data: q.workspaces }),
  useConnectGoogle: () => ({ mutate: q.connect, isPending: false, isError: false }),
  useDisconnectGoogle: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useMyFolderLinks: (enabled: boolean) => {
    q.folders(enabled);
    return { data: undefined };
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
  it("non collegato: il testo di Posta e Calendario, non del Drive; un solo Workspace, nessuna domanda", async () => {
    const dialog = await open();
    expect(dialog).toHaveTextContent("show your Gmail and Calendar here");
    expect(dialog).not.toHaveTextContent(/Google Drive files|link folders/);
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

  it("scaduta: Posta e Calendario non si aggiornano, non le cartelle", async () => {
    q.account = { ...connected, status: "expired", reconnect: "expired", since: "2026-11-10T08:00:00Z" };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Mail and Calendar don't update until you reconnect.");
    expect(dialog).not.toHaveTextContent("Folders you linked");
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

  it("le funzioni che mancano, in fila: letto/non letto e la firma", async () => {
    q.account = { ...connected, status: "expired", reconnect: "scopes", missing: ["markRead", "signature"] };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Until you reconnect, Stubwise can't mark mail as read or unread, add your Gmail signature.");
  });

  it("senza funzioni elencate (uno scope di una fetta futura): solo il titolo", async () => {
    q.account = { ...connected, status: "expired", reconnect: "scopes", missing: [] };
    const dialog = await open();
    expect(dialog).toHaveTextContent("Reconnect to give Stubwise the new permissions");
    expect(dialog).not.toHaveTextContent("Until you reconnect");
  });

  it("scollegare: niente cartelle del Drive (nessuna lettura), solo cosa smette Posta e Calendario", async () => {
    q.account = connected;
    const dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect(dialog).toHaveTextContent("Mail and Calendar will stop showing ada@acme.test too.");
    expect(dialog).not.toHaveTextContent(/folder you linked|Google Drive files/);
    expect(q.folders.mock.calls.every(([enabled]) => enabled === false)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Disconnect account" })).toBeEnabled();
  });
});
