import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  failNext,
  getTaskByCode,
  listStalled,
  listTasks,
  resetApi,
  setLatency,
} from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

// Le sezioni del pannello della task che la tabella di parità cita una per
// una: collegate, allegati, campi della testata, descrizione, richiesta
// d'origine, «ferma» a mano; poi l'esportazione, l'origine e i dati tecnici.

const panelOf = (code: string) => screen.findByRole("dialog", { name: `Task ${code}` });
const task = (code: string) => state.tasks.find((t) => t.code === code)!;
const region = (panel: HTMLElement, name: string) => within(panel).getByRole("region", { name });

/** Una task aperta e non ferma del progetto, vista da `me`. */
async function calmTask(projectId: string, me: string) {
  setSessionPersonId(me);
  const tasks = await listTasks({ projectIds: [projectId], families: ["todo", "active"] });
  const stalled = new Set((await listStalled({ projectIds: [projectId] })).map((r) => r.task.id));
  return tasks.find((t) => !stalled.has(t.id))!;
}

/** Appunti e scaricamento finti: cosa si è copiato, quale file e con che testo. */
function fakeExport() {
  const writes: string[] = [];
  const files: { name: string; blob: Blob }[] = [];
  let pending: Blob | null = null;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (s: string) => (writes.push(s), Promise.resolve()) },
  });
  const created = URL.createObjectURL;
  const revoked = URL.revokeObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (b: Blob) => ((pending = b), "blob:fake");
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    files.push({ name: this.download, blob: pending! });
  };
  const restore = () => {
    URL.createObjectURL = created;
    URL.revokeObjectURL = revoked;
    HTMLAnchorElement.prototype.click = click;
    Reflect.deleteProperty(navigator, "clipboard");
  };
  return { writes, files, restore };
}

let restoreExport: (() => void) | null = null;

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => {
  restoreExport?.();
  restoreExport = null;
});

describe("task collegate", () => {
  it("si aggiunge un collegamento cercando la task, e si toglie con conferma", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    const linked = await waitFor(() => region(panel, "Linked tasks"));
    expect(linked).toHaveTextContent("No linked tasks");
    await userEvent.click(within(linked).getByRole("button", { name: "Add" }));
    // Si offrono solo i versi che si salvano, come sul web.
    await userEvent.click(within(linked).getByRole("button", { name: "Link type: Related" }));
    const kinds = await screen.findByRole("menu", { name: "Link type" });
    expect(
      within(kinds)
        .getAllByRole("menuitemradio")
        .map((i) => i.textContent),
    ).toEqual(["Blocks", "Related", "Parent"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.type(
      within(linked).getByRole("textbox", { name: "Find a task" }),
      "Social posts",
    );
    const results = within(linked).getByRole("list", { name: "Tasks to link" });
    await userEvent.click(
      within(results).getByRole("button", { name: /Social posts for the showroom week/ }),
    );
    await waitFor(() =>
      expect(task("MKX-2").links).toEqual([{ kind: "relates", taskId: "t-mkx-4" }]),
    );
    expect(await within(linked).findByText("Related")).toBeInTheDocument();
    expect(
      within(linked).getByRole("button", { name: /^MKX-4\s?Social posts/ }),
    ).toBeInTheDocument();

    await userEvent.click(within(linked).getByRole("button", { name: "Remove the link to MKX-4" }));
    expect(
      within(linked).getByText("Remove the link «Related MKX-4»? It goes from both tasks."),
    ).toBeInTheDocument();
    await userEvent.click(within(linked).getByRole("button", { name: "Cancel" }));
    expect(task("MKX-2").links).toHaveLength(1);
    await userEvent.click(within(linked).getByRole("button", { name: "Remove the link to MKX-4" }));
    await userEvent.click(within(linked).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(task("MKX-2").links).toEqual([]));
    expect(await within(linked).findByText("No linked tasks")).toBeInTheDocument();
  });

  it("«Blocks MKX-4» su MKX-2: MKX-4 mostra «Blocked by MKX-2» ed è ferma; togliere la riga da MKX-4 la toglie ovunque", async () => {
    const router = renderRoute("/home?task=MKX-2", "p-giulia");
    let panel = await panelOf("MKX-2");
    let linked = await waitFor(() => region(panel, "Linked tasks"));
    await userEvent.click(within(linked).getByRole("button", { name: "Add" }));
    await userEvent.click(within(linked).getByRole("button", { name: "Link type: Related" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Blocks" }));
    await userEvent.type(
      within(linked).getByRole("textbox", { name: "Find a task" }),
      "Social posts",
    );
    await userEvent.click(
      within(within(linked).getByRole("list", { name: "Tasks to link" })).getByRole("button", {
        name: /Social posts/,
      }),
    );
    await waitFor(() =>
      expect(task("MKX-2").links).toEqual([{ kind: "blocks", taskId: "t-mkx-4" }]),
    );
    expect(task("MKX-4").links).toEqual([]);

    // Dall'altra parte: l'inverso ricavato, e il motivo «ferma».
    await userEvent.click(within(linked).getByRole("button", { name: /^MKX-4\s?Social posts/ }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ task: "MKX-4" }));
    panel = await panelOf("MKX-4");
    linked = await waitFor(() => region(panel, "Linked tasks"));
    expect(await within(linked).findByText("Blocked by")).toBeInTheDocument();
    expect(
      within(linked).getByRole("button", { name: /^MKX-2\s?Pick the hero/ }),
    ).toBeInTheDocument();
    await waitFor(() => expect(region(panel, "Stalled")).toHaveTextContent("Blocked by MKX-2"));

    await userEvent.click(within(linked).getByRole("button", { name: "Remove the link to MKX-2" }));
    await userEvent.click(within(linked).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(task("MKX-2").links).toEqual([]));
    expect(await within(linked).findByText("No linked tasks")).toBeInTheDocument();
    await waitFor(() => expect(region(panel, "Stalled")).toHaveTextContent("Not stalled"));
  });

  it("senza tickets.edit i collegamenti si leggono e basta", async () => {
    // Andrea non è membro di MKX: lo diventa col ruolo di sola lettura.
    state.projectsById.get("prj-mkx")!.memberIds.push("p-andrea");
    renderRoute("/home?task=MKX-7", "p-andrea");
    const panel = await panelOf("MKX-7");
    const linked = await waitFor(() => region(panel, "Linked tasks"));
    await within(linked).findByText("Blocked by");
    expect(within(linked).queryByRole("button", { name: "Add" })).toBeNull();
    expect(within(linked).queryByRole("button", { name: /^Remove the link/ })).toBeNull();
  });
});

describe("allegati", () => {
  it("elenco, aggiunta (file finto) e rimozione con conferma", async () => {
    renderRoute("/home?task=MKX-1", "p-giulia");
    const panel = await panelOf("MKX-1");
    const files = await waitFor(() => region(panel, "Attachments"));
    expect(within(files).getByText("brief.pdf")).toBeInTheDocument();
    expect(within(files).getByText(/471 KB/)).toBeInTheDocument();

    await userEvent.click(within(files).getByRole("button", { name: "Add" }));
    expect(await within(files).findByText("Brief.pdf")).toBeInTheDocument();
    expect(task("MKX-1").attachments.map((a) => a.name)).toEqual(["brief.pdf", "Brief.pdf"]);

    await userEvent.click(within(files).getByRole("button", { name: "Remove brief.pdf" }));
    expect(within(files).getByText("Remove brief.pdf from this task?")).toBeInTheDocument();
    // Annullare non toglie niente.
    await userEvent.click(within(files).getByRole("button", { name: "Cancel" }));
    expect(task("MKX-1").attachments).toHaveLength(2);
    await userEvent.click(within(files).getByRole("button", { name: "Remove brief.pdf" }));
    await userEvent.click(within(files).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(task("MKX-1").attachments.map((a) => a.name)).toEqual(["Brief.pdf"]),
    );
    expect(within(files).queryByText("brief.pdf")).toBeNull();
  });
});

describe("campi della testata", () => {
  it("assegnatario, traguardo ed etichette si cambiano dal pannello", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    const milestoneBefore = task("MKX-2").milestoneId;

    await userEvent.click(
      await within(panel).findByRole("button", { name: /^Assignee: .*Change$/ }),
    );
    const people = await screen.findByRole("menu", { name: "Assignee of MKX-2" });
    const someone = within(people)
      .getAllByRole("menuitemradio")
      .find((i) => i.getAttribute("aria-checked") === "false" && /Paolo/.test(i.textContent!))!;
    await userEvent.click(someone);
    await waitFor(() => expect(task("MKX-2").assigneeId).toBe("p-paolo"));

    await userEvent.click(within(panel).getByRole("button", { name: /^Milestone: .*Change$/ }));
    const milestones = await screen.findByRole("menu", { name: "Milestone of MKX-2" });
    const other = within(milestones)
      .getAllByRole("menuitemradio")
      .find((i) => i.getAttribute("aria-checked") === "false" && i.textContent !== "No milestone")!;
    const otherName = other.textContent!;
    await userEvent.click(other);
    await waitFor(() => expect(task("MKX-2").milestoneId).not.toBe(milestoneBefore));
    expect(
      within(panel).getByRole("button", { name: `Milestone: ${otherName}. Change` }),
    ).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: /^Priority: .*Change$/ }));
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "Priority of MKX-2" })).getByRole(
        "menuitemradio",
        { name: "Urgent" },
      ),
    );
    await waitFor(() => expect(task("MKX-2").priority).toBe("urgent"));
    await userEvent.click(within(panel).getByRole("button", { name: /^Type: .*Change$/ }));
    await userEvent.click(
      within(await screen.findByRole("menu", { name: "Type of MKX-2" })).getByRole(
        "menuitemradio",
        { name: "Bug" },
      ),
    );
    await waitFor(() => expect(task("MKX-2").type).toBe("bug"));

    await userEvent.click(within(panel).getByRole("button", { name: "Label" }));
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "New label" }),
      "showroom{Enter}",
    );
    await waitFor(() => expect(task("MKX-2").labels).toEqual(["showroom"]));
    await userEvent.click(
      await within(panel).findByRole("button", { name: "Remove the label showroom" }),
    );
    await waitFor(() => expect(task("MKX-2").labels).toEqual([]));
  });

  it("senza tickets.edit: assegnatario, traguardo ed etichette in sola lettura", async () => {
    renderRoute("/home?task=STW-6", "p-sara");
    const panel = await panelOf("STW-6");
    await within(panel).findByText("Milestone");
    expect(within(panel).queryByRole("button", { name: /^Assignee: .*Change$/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Milestone: .*Change$/ })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Label" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /^Remove the label/ })).toBeNull();
  });
});

describe("commenti", () => {
  it("si commenta e si risponde a un commento: la risposta sta sotto, legata a quello", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await userEvent.type(
      await within(panel).findByRole("textbox", { name: "Write a comment" }),
      "Two options for the hero",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Comment" }));
    const text = await within(panel).findByText("Two options for the hero");
    const item = text.closest("li")!;
    await userEvent.click(within(item).getByRole("button", { name: "Reply" }));
    await userEvent.type(
      within(item).getByRole("textbox", { name: "Write a reply" }),
      "The second one",
    );
    await userEvent.click(within(item).getAllByRole("button", { name: "Reply" }).at(-1)!);
    expect(await within(item).findByText("The second one")).toBeInTheDocument();
    const parent = state.activity.find((a) => a.body === "Two options for the hero")!;
    const reply = state.activity.find((a) => a.body === "The second one")!;
    expect(reply).toMatchObject({ kind: "comment", replyToId: parent.id, authorId: "p-giulia" });
  });
});

describe("descrizione", () => {
  it("si modifica, si salva e si mostra come markdown", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await userEvent.click(await within(panel).findByRole("button", { name: "Edit description" }));
    const field = within(panel).getByRole("textbox", { name: "Description" });
    await userEvent.clear(field);
    await userEvent.type(field, "Pick **two** photos");
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(task("MKX-2").description).toBe("Pick **two** photos"));
    const strong = await within(panel).findByText("two");
    expect(strong.tagName).toBe("STRONG");
    expect(within(panel).queryByRole("textbox", { name: "Description" })).toBeNull();
  });
});

describe("richiesta d'origine", () => {
  it("la task nata da una richiesta la mostra, e il link apre la richiesta", async () => {
    const router = renderRoute("/home?task=AUD-5", "p-giulia");
    const panel = await panelOf("AUD-5");
    const origin = await waitFor(() => region(panel, "Origin request"));
    const link = await within(origin).findByRole("link", { name: "Export the call history" });
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/p/AUD/requests"));
    expect(router.state.matches.at(-1)!.search).toMatchObject({ request: "req-aud-1" });
  });

  it("una task senza richiesta non ha la sezione", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await waitFor(() => region(panel, "Linked tasks"));
    expect(within(panel).queryByRole("region", { name: "Origin request" })).toBeNull();
  });
});

describe("ferma a mano", () => {
  it("«Mark as stalled» con motivo e nota, poi «Not stalled anymore»", async () => {
    const calm = await calmTask("prj-mkx", "p-giulia");
    renderRoute(`/home?task=${calm.code}`, "p-giulia");
    const panel = await panelOf(calm.code);
    const stalled = await waitFor(() => region(panel, "Stalled"));
    expect(stalled).toHaveTextContent("Not stalled");
    await userEvent.click(within(stalled).getByRole("button", { name: "Mark as stalled" }));
    const submit = within(stalled).getByRole("button", { name: "Mark as stalled" });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(stalled).getByRole("textbox", { name: "Reason" }),
      "Waiting on the printer",
    );
    await userEvent.type(within(stalled).getByRole("textbox", { name: "Note" }), "Back on Monday.");
    await userEvent.click(submit);
    await waitFor(() =>
      expect(task(calm.code).manualStall).toMatchObject({
        reason: "Waiting on the printer",
        note: "Back on Monday.",
        byId: "p-giulia",
      }),
    );
    const after = await waitFor(() => {
      const r = region(panel, "Stalled");
      expect(r).toHaveTextContent("Waiting on the printer");
      return r;
    });
    expect(after).toHaveTextContent("Back on Monday.");
    expect(after).toHaveTextContent("Marked by Giulia Ferri");

    await userEvent.click(within(after).getByRole("button", { name: "Not stalled anymore" }));
    await waitFor(() => expect(task(calm.code).manualStall).toBeNull());
    await waitFor(() => expect(region(panel, "Stalled")).toHaveTextContent("Not stalled"));
  });
});

describe("esportazione in Markdown", () => {
  it("«Copy as Markdown» e «Download .md» dal menu della testata", async () => {
    const fake = fakeExport();
    restoreExport = fake.restore;
    const t = (await (setSessionPersonId("p-giulia"), getTaskByCode("MKX-2")))!;
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await userEvent.click(
      await within(panel).findByRole("button", { name: "More actions for MKX-2" }),
    );
    const menu = await screen.findByRole("menu", { name: "More actions for MKX-2" });
    await userEvent.click(await within(menu).findByRole("menuitem", { name: "Copy as Markdown" }));
    await waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(fake.writes[0]!.startsWith(`# MKX-2 · ${t.title}\n`)).toBe(true);
    expect(fake.writes[0]).toContain("- **Project:** MKX · Campagne primavera Mix Cucine");
    expect(fake.writes[0]).toContain("## Description");
    expect(await screen.findByText("Copied MKX-2 as Markdown.")).toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "More actions for MKX-2" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /^Download \.md/ }));
    expect(fake.files.map((f) => f.name)).toEqual(["MKX-2.md"]);
    expect(await fake.files[0]!.blob.text()).toContain("# MKX-2 · ");
    expect(await screen.findByText("Downloaded MKX-2.md.")).toBeInTheDocument();
  });

  it("anche chi legge soltanto può esportare", async () => {
    renderRoute("/home?task=STW-6", "p-sara");
    const panel = await panelOf("STW-6");
    await userEvent.click(
      await within(panel).findByRole("button", { name: "More actions for STW-6" }),
    );
    expect(await screen.findByRole("menuitem", { name: "Copy as Markdown" })).toBeInTheDocument();
  });

  it("l'esportazione porta anche i collegamenti ricavati («Blocked by»)", async () => {
    const fake = fakeExport();
    restoreExport = fake.restore;
    renderRoute("/home?task=MKX-7", "p-giulia");
    const panel = await panelOf("MKX-7");
    await waitFor(() => expect(region(panel, "Linked tasks")).toHaveTextContent("Blocked by"));
    await userEvent.click(within(panel).getByRole("button", { name: "More actions for MKX-7" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Copy as Markdown" }));
    await waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(fake.writes[0]).toContain("## Linked tasks\n\n- Blocked by: MKX-6 · ");
  });

  it("se le letture dell'esportazione non riescono lo dice, e «Retry» le rifà", async () => {
    failNext("listActivity");
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await within(panel).findByText("Couldn't load the activity.");
    await userEvent.click(within(panel).getByRole("button", { name: "More actions for MKX-2" }));
    const menu = await screen.findByRole("menu", { name: "More actions for MKX-2" });
    expect(within(menu).getByText("Couldn't prepare the export.")).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Copy as Markdown" })).toBeNull();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Retry" }));
    expect(
      await within(menu).findByRole("menuitem", { name: "Copy as Markdown" }),
    ).toBeInTheDocument();
  });
});

describe("origine e dati tecnici", () => {
  it("una task dall'SDK dice l'origine con ×N, e i dati tecnici si aprono a richiesta", async () => {
    renderRoute("/home?task=STW-13", "p-laura");
    const panel = await panelOf("STW-13");
    const source = await within(panel).findByText("SDK");
    const value = source.closest("[data-source]")!;
    expect(value).toHaveAttribute("data-source", "sdk");
    expect(value.querySelector("[data-source-icon]")).not.toBeNull();
    expect(within(value as HTMLElement).getByTitle("Reported 12 times")).toHaveTextContent("×12");

    const technical = region(panel, "Technical details");
    const toggle = within(technical).getByRole("button", { name: "Show the technical details" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(technical).getByText("RangeError: Invalid array length")).not.toBeVisible();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(technical).getByText("RangeError: Invalid array length")).toBeVisible();
    expect(within(technical).getByText("release")).toBeInTheDocument();
  });

  it("una task fatta a mano non ha né origine né dati tecnici", async () => {
    renderRoute("/home?task=MKX-2", "p-giulia");
    const panel = await panelOf("MKX-2");
    await within(panel).findByText("Labels");
    expect(within(panel).queryByText("Source")).toBeNull();
    expect(within(panel).queryByRole("region", { name: "Technical details" })).toBeNull();
    // Nessun «View conversation»: le conversazioni del widget arrivano con l'area 8.
    expect(within(panel).queryByText(/View conversation/)).toBeNull();
  });
});
