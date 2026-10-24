import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, failNext, listProjects, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { can, grantProjectRole, resetViewerGrants, viewerFor } from "../../data/viewer";
import { renderRoute } from "../../test/renderRoute";

const search = (router: ReturnType<typeof renderRoute>) =>
  router.state.matches.at(-1)!.search as Record<string, unknown>;
const path = (router: ReturnType<typeof renderRoute>) => router.state.location.pathname;
const panel = () => screen.findByRole("dialog", { name: "Request" });
const request = (id: string) => state.requests.find((r) => r.id === id)!;
/** La riga di una richiesta, quando c'è (lancia finché non c'è: per `waitFor`). */
const rowOf = (id: string) => {
  const el = document.querySelector(`[data-request-row="${id}"]`);
  if (!el) throw new Error(`no row ${id}`);
  return el as HTMLElement;
};

/** Un progetto vuoto in cui `personId` entra col ruolo indicato. */
async function emptyProject(code: string, personId: string, role: string) {
  setSessionPersonId("p-roberta");
  const project = await createProject({ code, name: "Vuoto", template: "empty" });
  state.projectsById.get(project.id)!.memberIds.push(personId);
  grantProjectRole(personId, project.id, role);
  return project;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetViewerGrants());

describe("RequestsPage", () => {
  it("elenca le richieste per stato, con richiedenti, «Requested N times», urgenza e task", async () => {
    renderRoute("/p/STW/requests", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "Requests" })).toBeInTheDocument();
    // Di base le aperte: le trasformate e le archiviate non ci sono.
    expect(screen.getByRole("list", { name: "New" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Turned into task" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Status:/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "All" }));
    const row = document.querySelector('[data-request-row="req-stw-2"]') as HTMLElement;
    expect(row).toHaveTextContent("Requested 3 times");
    expect(row).toHaveTextContent("Turned into task");
    expect(row).toHaveTextContent("High");
    expect(row).toHaveTextContent("1 task");
    expect(row.querySelector("[data-size]")).toHaveAttribute("data-size", "L");
    const unsized = document.querySelector('[data-request-row="req-stw-1"]') as HTMLElement;
    expect(within(unsized).getByRole("img", { name: "No estimate" })).toBeInTheDocument();
    const merged = document.querySelector('[data-request-row="req-stw-3"]') as HTMLElement;
    expect(merged).toHaveTextContent("Merged into “Move tasks on a board with the keyboard”");
  });

  it("filtra per testo; senza risultati offre di togliere i filtri", async () => {
    renderRoute("/p/STW/requests", "p-giulia");
    const box = await screen.findByRole("searchbox", { name: "Search requests" });
    await userEvent.type(box, "quiet");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-request-row]")).toHaveLength(1),
    );
    await userEvent.clear(box);
    await userEvent.type(box, "zzzz");
    expect(await screen.findByText("No requests match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(document.querySelectorAll("[data-request-row]").length).toBeGreaterThan(3),
    );
  });

  it("errore al posto dell'elenco, con Retry", async () => {
    failNext("listRequests");
    renderRoute("/p/STW/requests", "p-giulia");
    expect(await screen.findByText("Couldn't load requests.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.querySelector("[data-request-row]")).not.toBeNull());
  });

  it("elenco vuoto con il permesso: spiega a cosa servono e offre «New request»", async () => {
    await emptyProject("ZZR", "p-sara", "contributor");
    const router = renderRoute("/p/ZZR/requests", "p-sara");
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    expect(screen.getByText(/Requests are how anyone proposes something new/)).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "New request" });
    await userEvent.click(buttons.at(-1)!);
    expect(search(router).newRequest).toBe("ZZR");
    expect(await screen.findByRole("dialog", { name: "New request" })).toBeInTheDocument();
  });

  it("elenco vuoto senza permesso: dice chi può, nessun «New request»", async () => {
    await emptyProject("ZZV", "p-irene", "viewer");
    renderRoute("/p/ZZV/requests", "p-irene");
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    expect(
      screen.getByText("Only people who can send requests to Vuoto can add one."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New request" })).toBeNull();
  });
});

describe("pannello della richiesta", () => {
  it("clic su una riga apre il pannello (?request=); Esc lo chiude", async () => {
    const router = renderRoute("/p/STW/requests", "p-giulia");
    const row = await waitFor(() => rowOf("req-stw-4"));
    await userEvent.click(within(row).getByRole("button", { name: /Quiet hours/ }));
    expect(search(router).request).toBe("req-stw-4");
    const dialog = await panel();
    expect(within(dialog).getByRole("heading", { name: "Quiet hours for notifications" })).toBeInTheDocument();
    expect(within(dialog).getByText(/Refinement with Claude has started/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(search(router).request).toBeUndefined());
  });

  it("Turn into task: crea la task, la collega e porta la richiesta a «Turned into task» col link", async () => {
    const router = renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
    const dialog = await panel();
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn into task" }));
    const form = await screen.findByRole("dialog", { name: "New task" });
    expect(within(form).getByRole("textbox", { name: "Title" })).toHaveValue(
      "Landing page for the showroom event",
    );
    await userEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());

    const converted = request("req-mkx-2");
    expect(converted.status).toBe("converted");
    const task = state.tasks.find((t) => t.id === converted.taskIds[0])!;
    expect(task.requestId).toBe("req-mkx-2");

    const after = await panel();
    expect(await within(after).findByText(/Turned into a task/)).toBeInTheDocument();
    expect(within(after).queryByRole("button", { name: "Turn into task" })).toBeNull();
    const link = await waitFor(() =>
      within(after).getByRole("button", { name: new RegExp(task.code) }),
    );
    await userEvent.click(link);
    expect(search(router).task).toBe(task.code);
    expect(search(router).request).toBeUndefined();
  });

  it("Merge into…: le simili per prime; unisce i richiedenti e la fusa mostra «Merged into …»", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-3", "p-giulia");
    const dialog = await panel();
    await userEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Merge into…" }));
    const merge = await screen.findByRole("dialog", { name: "Merge into another request" });
    await userEvent.click(
      within(merge).getByRole("radio", { name: /Landing page for the showroom event/ }),
    );
    await userEvent.click(within(merge).getByRole("button", { name: "Merge" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Merge into another request" })).toBeNull(),
    );
    expect(request("req-mkx-2").requesterIds.sort()).toEqual(
      ["p-elena", "p-francesca", "p-matteo"].sort(),
    );
    expect(request("req-mkx-3")).toMatchObject({ status: "archived", mergedIntoId: "req-mkx-2" });
    const after = await panel();
    expect(
      await within(after).findByRole("button", {
        name: "Merged into “Landing page for the showroom event”",
      }),
    ).toBeInTheDocument();
    expect(within(after).queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("Sara (contributor): «New request» sì, «Merge», «Archive» e «Refine» no", async () => {
    renderRoute("/p/STW/requests?request=req-stw-1", "p-sara");
    expect(await screen.findByRole("button", { name: "New request" })).toBeInTheDocument();
    const dialog = await panel();
    await within(dialog).findByRole("heading", { name: "Show who moved a task to another week" });
    expect(within(dialog).queryByRole("button", { name: "Refine with Claude" })).toBeNull();
    // «More actions» c'è (l'esportazione è per tutti), ma senza Merge né Archive.
    await userEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
    const menu = await screen.findByRole("menu", { name: "More actions" });
    expect(within(menu).getByRole("menuitem", { name: "Copy as Markdown" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Merge into…" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Archive" })).toBeNull();
    // I metadati si leggono e basta.
    expect(within(dialog).getByText("Medium")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Urgency: .*Change$/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Size: .*Change$/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Risk: .*Change$/ })).toBeNull();
  });

  it("metadati con backlog.edit: urgenza, taglia, rischio e nota si cambiano dal pannello", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-3", "p-giulia");
    const dialog = await panel();
    await userEvent.click(within(dialog).getByRole("button", { name: "Urgency: Medium. Change" }));
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "Urgency of this request" })).getByRole(
        "menuitemradio",
        { name: /High/ },
      ),
    );
    await waitFor(() => expect(request("req-mkx-3").urgency).toBe("high"));

    await userEvent.click(within(dialog).getByRole("button", { name: "Size: L. Change" }));
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "Size of this request" })).getByRole(
        "menuitemradio",
        { name: "XS" },
      ),
    );
    await waitFor(() => expect(request("req-mkx-3").size).toBe("XS"));

    await userEvent.click(within(dialog).getByRole("button", { name: "Risk: Low. Change" }));
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "Risk of this request" })).getByRole(
        "menuitemradio",
        { name: /High/ },
      ),
    );
    await waitFor(() => expect(request("req-mkx-3").risk).toBe("high"));

    await userEvent.click(within(dialog).getByRole("button", { name: "Add a note" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Risk note" }), "Video crew booked late{Enter}");
    await waitFor(() => expect(request("req-mkx-3").riskNote).toBe("Video crew booked late"));
    expect(await within(dialog).findByText("Video crew booked late")).toBeInTheDocument();
  });

  it("un cambio di metadati che non riesce lo dice, e la richiesta resta com'era", async () => {
    failNext("updateRequest");
    renderRoute("/p/MKX/requests?request=req-mkx-3", "p-giulia");
    const dialog = await panel();
    await userEvent.click(within(dialog).getByRole("button", { name: "Size: L. Change" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "S" }));
    expect(
      await screen.findByText("Couldn't save the change. The request is as it was."),
    ).toBeInTheDocument();
    expect(request("req-mkx-3").size).toBe("L");
  });

  it("Copy as Markdown e Download .md esportano la richiesta", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => (writes.push(s), Promise.resolve()) },
    });
    const blobs: Blob[] = [];
    const created = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.createObjectURL = (b: Blob) => (blobs.push(b), "blob:fake");
    URL.revokeObjectURL = () => {};
    let downloaded = "";
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloaded = this.download;
    };
    try {
      renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
      const dialog = await panel();
      await userEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toContain("# Landing page for the showroom event");
      expect(writes[0]).toContain("- **Risk:** High — The showroom date is fixed: no room to slip.");
      expect(writes[0]).toContain("- **Requested by:** Francesca");
      expect(await screen.findByText(/Copied Landing page for the showroom event as Markdown/)).toBeInTheDocument();

      await userEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Download .md" }));
      expect(downloaded).toBe("request-landing-page-for-the-showroom-event.md");
      expect(await blobs[0]!.text()).toContain("# Landing page for the showroom event");
    } finally {
      URL.createObjectURL = created;
      URL.revokeObjectURL = revoked;
      HTMLAnchorElement.prototype.click = click;
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("appunti non disponibili: lo dice e propone Download", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    try {
      renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
      const dialog = await panel();
      await userEvent.click(within(dialog).getByRole("button", { name: "More actions" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }));
      expect(
        await screen.findByText("Couldn't copy to the clipboard. Use Download .md instead."),
      ).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("Turn into task: la task nasce con la taglia della richiesta", async () => {
    renderRoute("/p/MKX/requests?request=req-mkx-2", "p-giulia");
    const dialog = await panel();
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn into task" }));
    const form = await screen.findByRole("dialog", { name: "New task" });
    expect(await within(form).findByRole("button", { name: /^Size: M/ })).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(request("req-mkx-2").status).toBe("converted"));
    const task = state.tasks.find((t) => t.id === request("req-mkx-2").taskIds[0])!;
    expect(task.size).toBe("M");
  });

  it("Irene (viewer): niente «New request» né «Turn into task»; una riga dice chi decide", async () => {
    const project = await emptyProject("ZZI", "p-irene", "viewer");
    setSessionPersonId("p-roberta");
    state.requests.push({
      ...request("req-stw-1"),
      id: "req-zzi-1",
      projectId: project.id,
      title: "A request Irene can read",
    });
    renderRoute("/p/ZZI/requests?request=req-zzi-1", "p-irene");
    const dialog = await panel();
    expect(
      await within(dialog).findByText("The team reviews requests and decides what becomes a task."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Turn into task" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New request" })).toBeNull();
  });

  async function archiveThenUndo(id: string, personId: string, code: string) {
    renderRoute(`/p/${code}/requests?request=${id}`, personId);
    const dialog = await panel();
    await userEvent.click(await within(dialog).findByRole("button", { name: "More actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(request(id).status).toBe("archived"));
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
  }

  it("Archive → Undo: una richiesta in rifinitura torna in rifinitura, con la sua riga", async () => {
    await archiveThenUndo("req-stw-4", "p-roberta", "STW");
    await waitFor(() => expect(request("req-stw-4").status).toBe("refining"));
    const dialog = await panel();
    expect(await within(dialog).findByText(/Refinement with Claude has started/)).toBeInTheDocument();
  });

  it("Archive → Undo: una richiesta pronta torna pronta", async () => {
    await archiveThenUndo("req-mkx-3", "p-giulia", "MKX");
    await waitFor(() => expect(request("req-mkx-3").status).toBe("ready"));
  });

  it("Undo che non riesce: lo dice, e la richiesta resta archiviata", async () => {
    failNext("restoreRequest");
    await archiveThenUndo("req-mkx-3", "p-giulia", "MKX");
    expect(
      await screen.findByText("Couldn't undo: the request is still archived."),
    ).toBeInTheDocument();
    expect(request("req-mkx-3").status).toBe("archived");
  });

  it("una richiesta fusa non offre «Reopen»", async () => {
    renderRoute("/p/STW/requests?request=req-stw-3", "p-roberta");
    const dialog = await panel();
    await within(dialog).findByRole("button", { name: /Merged into/ });
    expect(within(dialog).queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("una richiesta di un altro progetto: il pannello la tratta come non trovata", async () => {
    renderRoute("/p/MKX/requests?request=req-stw-1", "p-roberta");
    const dialog = await panel();
    expect(
      await within(dialog).findByText("This request doesn't exist or you can't see it"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: /Show who moved/ })).toBeNull();
  });

  it("una richiesta che non c'è: il pannello lo dice", async () => {
    renderRoute("/p/STW/requests?request=req-nope", "p-giulia");
    const dialog = await panel();
    expect(
      await within(dialog).findByText("This request doesn't exist or you can't see it"),
    ).toBeInTheDocument();
  });
});

describe("New request (?newRequest=)", () => {
  it("newRequest=1 fuori da un progetto: si sceglie fra i progetti con backlog.create", async () => {
    setSessionPersonId("p-sara");
    const allowed = (await listProjects()).filter((p) =>
      can(viewerFor("p-sara"), "backlog.create", p.id),
    );
    const router = renderRoute("/home?newRequest=1", "p-sara");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    const picker = within(dialog).getByRole("button", { name: /^Project/ });
    expect(picker).toHaveTextContent("Choose a project");
    // Senza progetto non parte.
    await userEvent.type(within(dialog).getByRole("textbox", { name: "What do you need?" }), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(within(dialog).getByText("Choose the project this request is for.")).toBeInTheDocument();

    await userEvent.click(picker);
    const menu = await screen.findByRole("menu", { name: "Project" });
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(allowed.length);
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /STW/ }));
    const title = within(dialog).getByRole("textbox", { name: "What do you need?" });
    await userEvent.clear(title);
    await userEvent.type(title, "Quiet hours for my notifications");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));

    await waitFor(() => expect(path(router)).toBe("/p/STW/requests"));
    const created = state.requests.find((r) => r.title === "Quiet hours for my notifications")!;
    expect(created.requesterIds).toEqual(["p-sara"]);
    expect(search(router).request).toBe(created.id);
    expect(search(router).newRequest).toBeUndefined();
    const row = await waitFor(() => rowOf(created.id));
    expect(row).toHaveTextContent("Similar to “Quiet hours for notifications”");
  });

  it("newRequest=<CODE> dove si può: progetto già scelto", async () => {
    renderRoute("/p/STW/requests?newRequest=STW", "p-sara");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    expect(within(dialog).getByRole("button", { name: /^Project/ })).toHaveTextContent("STW");
  });

  it("newRequest=<CODE> dove non si può: si torna alla scelta", async () => {
    await emptyProject("ZZW", "p-irene", "viewer");
    renderRoute("/p/ZZW/requests?newRequest=ZZW", "p-irene");
    const dialog = await screen.findByRole("dialog", { name: "New request" });
    expect(within(dialog).getByRole("button", { name: /^Project/ })).not.toHaveTextContent("ZZW");
  });
});
