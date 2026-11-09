import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createProject, listProjects, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { ViewerProvider, can, grantProjectRole, viewerFor } from "../../data/viewer";
import { createAppRouter } from "../../router";
import { ThemeProvider } from "../../theme/ThemeProvider";

function renderAt(path: string, personId?: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>,
  );
  return router;
}

const search = (router: ReturnType<typeof renderAt>) => router.state.matches.at(-1)!.search;

/** Un progetto che Giulia vede da Viewer: lo vede, ma non ci crea task. */
async function viewOnlyProject() {
  setSessionPersonId("p-roberta");
  const project = await createProject({ code: "ZZV", name: "Solo lettura", template: "empty" });
  state.projectsById.get(project.id)!.memberIds.push("p-giulia");
  grantProjectRole("p-giulia", project.id, "viewer");
  return project;
}

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("NewTaskDialog", () => {
  it("senza progetto elenca solo i progetti dove si possono creare task", async () => {
    const readOnly = await viewOnlyProject();
    setSessionPersonId("p-giulia");
    const visible = await listProjects();
    const allowed = visible.filter((p) => can(viewerFor("p-giulia"), "tickets.create", p.id));
    expect(visible.some((p) => p.id === readOnly.id)).toBe(true);

    renderAt("/home?newTask=1", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(within(dialog).getByRole("button", { name: /^Project/ }));
    const menu = await screen.findByRole("menu", { name: "Project" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(allowed.length);
    expect(within(menu).queryByText("Solo lettura")).toBeNull();
  });

  it("project=<CODE> dove non si può creare: si torna alla scelta del progetto", async () => {
    await viewOnlyProject();
    renderAt("/home?newTask=1&project=ZZV", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(within(dialog).getByRole("button", { name: /^Project/ })).toHaveTextContent(
      "Choose a project",
    );
  });

  it("crea la task nel progetto preselezionato e ne apre il pannello", async () => {
    const router = renderAt("/p/MKX/tasks?newTask=1&project=MKX", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(within(dialog).getByRole("button", { name: /^Project/ })).toHaveTextContent("MKX");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Shoot the hero");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
    const created = state.tasks.find((t) => t.title === "Shoot the hero")!;
    expect(created.projectId).toBe("prj-mkx");
    // Reparto proposto: il primo di chi crea; stato: il primo «da fare».
    expect(created.departmentId).toBe("dep-marketing");
    await waitFor(() => expect(search(router)).toMatchObject({ task: created.code }));
    expect(search(router)).not.toHaveProperty("newTask", "1");
    const panel = await screen.findByRole("dialog", { name: `Task ${created.code}` });
    expect(await within(panel).findByRole("heading", { name: "Shoot the hero" })).toBeInTheDocument();
  });

  it("Annulla chiude e toglie il parametro", async () => {
    const router = renderAt("/home?newTask=1", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(search(router).newTask).toBeUndefined());
  });

  it("con un titolo scritto, Esc e il clic fuori chiedono se buttarlo", async () => {
    const router = renderAt("/home?newTask=1", "p-giulia");
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Title" }), "Da non perdere");
    await userEvent.keyboard("{Escape}");
    // Il dialogo resta, con la domanda nel piede.
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    expect(within(dialog).getByText("Discard this task? What you wrote will be lost.")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(within(dialog).getByRole("textbox", { name: "Title" })).toHaveValue("Da non perdere");

    // Clic sul fondo: stessa domanda; «Discard» chiude davvero.
    await userEvent.click(dialog.parentElement!);
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
    expect(search(router).newTask).toBeUndefined();
  });

  it("senza testo scritto Esc chiude il dialogo senza chiedere", async () => {
    renderAt("/home?newTask=1", "p-giulia");
    await screen.findByRole("dialog", { name: "New task" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
  });
});
