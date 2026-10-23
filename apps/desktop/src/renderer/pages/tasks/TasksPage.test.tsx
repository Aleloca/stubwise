import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createProject, failNext, resetApi, setLatency } from "../../data/api";
import { setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { ViewerProvider } from "../../data/viewer";
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

beforeEach(() => {
  setLatency(0);
  resetApi();
});

describe("TasksPage", () => {
  it("errore al posto del corpo, con Retry; la testata resta", async () => {
    failNext("listTasks");
    renderAt("/p/MKX/tasks", "p-giulia");
    expect(await screen.findByText("Couldn't load tasks.")).toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Tasks commands" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(document.querySelector("[data-task-row]")).not.toBeNull());
  });

  it("progetto vuoto: «New task» a chi può crearle, e lo apre nell'indirizzo", async () => {
    setSessionPersonId("p-roberta");
    await createProject({ code: "ZZZ", name: "Vuoto", template: "empty" });
    const router = renderAt("/p/ZZZ/tasks", "p-roberta");
    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeInTheDocument();
    const body = screen.getByText("Create the first task of Vuoto.").parentElement!;
    await userEvent.click(within(body).getByRole("button", { name: "New task" }));
    await waitFor(() => expect(search(router)).toMatchObject({ newTask: "1", project: "ZZZ" }));
  });

  it("progetto vuoto, senza tickets.create: la frase su chi può", async () => {
    setSessionPersonId("p-roberta");
    const project = await createProject({ code: "ZZZ", name: "Vuoto", template: "empty" });
    // Andrea (Viewer) entra fra i membri: vede il progetto ma non crea task.
    state.projectsById.get(project.id)!.memberIds.push("p-andrea");
    renderAt("/p/ZZZ/tasks", "p-andrea");
    expect(await screen.findByRole("heading", { name: "No tasks yet" })).toBeInTheDocument();
    expect(
      screen.getByText("Only people who can create tasks in Vuoto can add one."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("nessuna corrispondenza: «Clear filters» scrive criteri vuoti nell'indirizzo", async () => {
    const filters = encodeURIComponent(JSON.stringify({ text: "zzzz-nessuna" }));
    const router = renderAt(`/p/MKX/tasks?filters=${filters}`, "p-giulia");
    expect(
      await screen.findByRole("heading", { name: "No tasks match these filters" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" }).at(-1)!);
    await waitFor(() => expect(search(router)).toMatchObject({ filters: {} }));
    await waitFor(() => expect(document.querySelector("[data-task-row]")).not.toBeNull());
  });

  it("la vista sta nell'indirizzo; un clic su una riga apre ?task=", async () => {
    const router = renderAt("/p/MKX/tasks", "p-giulia");
    await waitFor(() => expect(document.querySelector("[data-task-row]")).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Board" }));
    await waitFor(() => expect(search(router)).toMatchObject({ view: "board" }));
    await waitFor(() => expect(document.querySelector("[data-card]")).not.toBeNull());
    const card = document.querySelector<HTMLElement>("[data-card]")!;
    await userEvent.click(card);
    await waitFor(() =>
      expect(search(router)).toMatchObject({ view: "board", task: card.dataset.card }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    await waitFor(() => expect(document.querySelector("[data-timeline-item]")).not.toBeNull());
  });

  it("con tickets.create «New task» sta nella testata (Sara, Contributor, su STW)", async () => {
    renderAt("/p/STW/tasks", "p-sara");
    await waitFor(() => expect(document.querySelector("[data-task-row]")).not.toBeNull());
    const toolbar = screen.getByRole("toolbar", { name: "Tasks commands" });
    expect(within(toolbar).getByRole("button", { name: "New task" })).toBeInTheDocument();
  });

  // Per ultimo: con la latenza le chiamate ancora in volo a fine test
  // consumerebbero il `failNext` del test che viene dopo.
  it("mentre carica mostra righe scheletro sotto una testata già in piedi", async () => {
    setLatency(40);
    renderAt("/p/MKX/tasks", "p-giulia");
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelectorAll("[data-skeleton-row]").length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(document.querySelector("[data-task-row]")).not.toBeNull());
    expect(document.querySelector("[data-skeleton-row]")).toBeNull();
  });
});
