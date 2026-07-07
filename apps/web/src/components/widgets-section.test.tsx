import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Widget } from "../lib/api";
import { widgetsQueryOptions } from "../lib/queries";
import { WidgetsSection } from "./widgets-section";

/**
 * Sezione "Widget di assistenza" del dettaglio progetto: lista di widget + editor
 * inline (nome, toggle, checklist fonti, campi config, cap giornalieri, snippet
 * con la chiave del widget, elimina con conferma). Il modulo `../lib/api` è
 * mockato (createWidget/updateWidget/deleteWidget); la lista si semina nella
 * cache di TanStack Query così `useSuspenseQuery` risolve subito, senza rete.
 */

const createWidget = vi.fn();
const updateWidget = vi.fn();
const deleteWidget = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    createWidget: (...args: unknown[]) => createWidget(...args),
    updateWidget: (...args: unknown[]) => updateWidget(...args),
    deleteWidget: (...args: unknown[]) => deleteWidget(...args),
  };
});

// Il filtro fine per-repo (WidgetSectionFilter) carica l'albero Docs on-demand;
// qui basta una foresta minima per il repo A (nodo con sourcePath).
const getDocTree = vi.fn();
vi.mock("../lib/docs-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docs-api")>();
  return { ...actual, getDocTree: (...args: unknown[]) => getDocTree(...args) };
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WIDGET_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const repositories = [
  { id: REPO_A, name: "web", slug: "acme-web" },
  { id: REPO_B, name: "api", slug: "acme-api" },
];

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: WIDGET_ID,
    name: "Assistenza",
    key: "wkey-abc-123",
    enabled: true,
    enabledRepositoryIds: [REPO_A],
    repositoryFilters: {},
    title: "Assistenza",
    welcomeMessage: "Ciao!",
    instructions: "",
    accentColor: "#22c55e",
    language: "it",
    dailyMessageCap: null,
    dailyTicketCap: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    conversationCount: 3,
    ...overrides,
  };
}

function renderSection(widgets: Widget[], isAdmin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(widgetsQueryOptions(PROJECT_ID).queryKey, { widgets });
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div>loading</div>}>
        <WidgetsSection
          projectId={PROJECT_ID}
          repositories={repositories}
          slug="acme"
          projectName="Acme"
          isAdmin={isAdmin}
        />
      </Suspense>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  createWidget.mockReset();
  updateWidget.mockReset();
  deleteWidget.mockReset();
  getDocTree.mockReset();
});

describe("WidgetsSection", () => {
  it("mostra la lista dei widget con nome, stato e conteggio conversazioni", async () => {
    renderSection([
      makeWidget({ id: WIDGET_ID, name: "Landing", enabled: true, conversationCount: 3 }),
      makeWidget({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        name: "App",
        enabled: false,
        conversationCount: 0,
      }),
    ]);

    expect(await screen.findByText("Landing")).toBeInTheDocument();
    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("3 conversations")).toBeInTheDocument();
    expect(screen.getByText("0 conversations")).toBeInTheDocument();
  });

  it("«New widget» apre l'editor vuoto e il submit chiama createWidget col payload di default", async () => {
    const user = userEvent.setup();
    createWidget.mockResolvedValue({ widget: makeWidget({ name: "Landing" }) });
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "New widget" }));

    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("");
    await user.type(name, "Landing");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createWidget).toHaveBeenCalledTimes(1));
    expect(createWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        name: "Landing",
        enabled: false,
        enabledRepositoryIds: [],
        title: "Assistenza",
        language: "it",
        dailyMessageCap: null,
        dailyTicketCap: null,
      }),
    );
  });

  it("l'editor di un widget esistente precompila e updateWidget riceve il body completo", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    renderSection([makeWidget({ name: "Landing", enabledRepositoryIds: [REPO_A] })]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Landing");
    expect(screen.getByLabelText("Enable the widget")).toBeChecked();
    expect(screen.getByLabelText("web")).toBeChecked();
    expect(screen.getByLabelText("api")).not.toBeChecked();

    // Valorizza un cap, lascia l'altro vuoto (→ null).
    await user.type(screen.getByLabelText("Daily message cap"), "500");
    await user.click(screen.getByLabelText("api"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({
        name: "Landing",
        enabled: true,
        enabledRepositoryIds: [REPO_A, REPO_B],
        dailyMessageCap: 500,
        dailyTicketCap: null,
      }),
    );
  });

  it("le istruzioni precompilano dall'esistente e finiscono nel payload della PUT", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    renderSection([
      makeWidget({ name: "Landing", instructions: "Tono formale, cita il piano Pro." }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const field = screen.getByLabelText("Assistant instructions");
    expect(field).toHaveValue("Tono formale, cita il piano Pro.");
    await user.clear(field);
    await user.type(field, "Dai priorità alla fatturazione.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({ instructions: "Dai priorità alla fatturazione." }),
    );
  });

  it("lo snippet contiene la chiave del widget e lo slug, non la ingestionKey", async () => {
    const user = userEvent.setup();
    // La chiave del widget è distinta dalla ingestionKey del progetto: lo
    // snippet deve portare la PRIMA (`widget.key`), non la seconda.
    renderSection([makeWidget({ key: "widgetkey123" })]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    const snippet = screen.getByTestId("widget-snippet");
    expect(snippet.textContent).toContain("/widget.js");
    expect(snippet.textContent).toContain("widgetkey123@");
    expect(snippet.textContent).toContain("/p/acme");
    // La ingestionKey del progetto NON compare: lo snippet è per-widget.
    expect(snippet.textContent).not.toContain("0123456789abcdef");
  });

  it("un widget nuovo non ha snippet finché non è salvato", async () => {
    const user = userEvent.setup();
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "New widget" }));

    expect(screen.queryByTestId("widget-snippet")).not.toBeInTheDocument();
  });

  it("elimina con conferma due-step chiama deleteWidget", async () => {
    const user = userEvent.setup();
    deleteWidget.mockResolvedValue(undefined);
    renderSection([makeWidget()]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Delete widget" }));
    // Conferma richiesta prima della chiamata.
    expect(deleteWidget).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    await waitFor(() => expect(deleteWidget).toHaveBeenCalledWith(PROJECT_ID, WIDGET_ID));
  });

  it("mostra il warning quando è abilitato senza fonti", async () => {
    const user = userEvent.setup();
    renderSection([makeWidget({ enabled: true, enabledRepositoryIds: [] })]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.getByText("No source selected: the widget will reply that it has no information."),
    ).toBeInTheDocument();
  });

  it("traduce l'errore 422 invalid_repository dal server", async () => {
    const user = userEvent.setup();
    createWidget.mockRejectedValue(
      new ApiError(422, "enabledRepositoryIds must reference repositories", "invalid_repository"),
    );
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "New widget" }));
    await user.type(screen.getByLabelText("Name"), "Landing");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("One or more selected repositories do not belong to this project"),
    ).toBeInTheDocument();
  });

  it("il submit include repositoryFilters (di default vuoto)", async () => {
    const user = userEvent.setup();
    createWidget.mockResolvedValue({ widget: makeWidget({ name: "Landing" }) });
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "New widget" }));
    await user.type(screen.getByLabelText("Name"), "Landing");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createWidget).toHaveBeenCalledTimes(1));
    expect(createWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ repositoryFilters: {} }),
    );
  });

  it("un widget CON filtri salvati precompila il form e il PUT li conserva (no wipe)", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    const savedFilters = { [REPO_A]: { paths: ["apps/webapp"], slugs: ["faq"], kinds: [] } };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    // Salva SENZA toccare il filtro: i filtri salvati devono sopravvivere al PUT.
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({ repositoryFilters: savedFilters }),
    );
  });

  it("editare un path conserva i kinds salvati (anti-wipe del contratto completo)", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    // Foresta del repo A: un nodo technical con sourcePath. Il filtro salvato ha
    // kinds=["functional"] e nessun path: aggiungere il path NON deve azzerare i kinds.
    getDocTree.mockResolvedValue([
      {
        id: "root",
        slug: "root",
        title: "Webapp",
        kind: "technical",
        parentId: null,
        position: 0,
        sourcePath: "apps/webapp",
        isManual: false,
      },
    ]);
    const savedFilters = {
      [REPO_A]: { paths: [], slugs: [], kinds: ["functional" as const] },
    };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    // Il blocco filtro è aperto (filtro esistente). Espando il gruppo Technical e
    // spunto il nodo → deve aggiungere il path e PRESERVARE kinds=["functional"].
    await user.click(await screen.findByRole("button", { name: /expand.*technical/i }));
    await user.click(await screen.findByLabelText("Webapp"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({
        repositoryFilters: {
          [REPO_A]: { paths: ["apps/webapp"], slugs: [], kinds: ["functional"] },
        },
      }),
    );
  });

  it("deselezionare un repo scarta la sua entry dai repositoryFilters del payload", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    const savedFilters = { [REPO_A]: { paths: ["apps/webapp"], slugs: [], kinds: [] } };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    // Deseleziona REPO_A: la sua entry di filtro deve sparire (server 422 altrimenti).
    await user.click(screen.getByLabelText("web"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({ enabledRepositoryIds: [], repositoryFilters: {} }),
    );
  });

  it("abilitare un repo su un widget NUOVO nasce col filtro kinds=[\"product\"] (default sicuro)", async () => {
    const user = userEvent.setup();
    createWidget.mockResolvedValue({ widget: makeWidget({ name: "Landing" }) });
    renderSection([]);

    await user.click(await screen.findByRole("button", { name: "New widget" }));
    await user.type(screen.getByLabelText("Name"), "Landing");
    // Abilita il repo A: l'entry di filtro deve nascere orientata al product.
    await user.click(screen.getByLabelText("web"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(createWidget).toHaveBeenCalledTimes(1));
    expect(createWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        enabledRepositoryIds: [REPO_A],
        repositoryFilters: { [REPO_A]: { paths: [], slugs: [], kinds: ["product"] } },
      }),
    );
  });

  it("abilitare un repo che non aveva entry usa il default product anche su widget esistente", async () => {
    const user = userEvent.setup();
    updateWidget.mockResolvedValue({ widget: makeWidget() });
    // Widget con REPO_A abilitato e un filtro salvato; REPO_B non ha entry.
    const savedFilters = { [REPO_A]: { paths: [], slugs: [], kinds: ["product" as const] } };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));
    // Abilita REPO_B (nuovo repo, senza entry): default product.
    await user.click(screen.getByLabelText("api"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateWidget).toHaveBeenCalledTimes(1));
    expect(updateWidget).toHaveBeenCalledWith(
      PROJECT_ID,
      WIDGET_ID,
      expect.objectContaining({
        enabledRepositoryIds: [REPO_A, REPO_B],
        repositoryFilters: {
          [REPO_A]: { paths: [], slugs: [], kinds: ["product"] },
          [REPO_B]: { paths: [], slugs: [], kinds: ["product"] },
        },
      }),
    );
  });

  it("il warning documentazione interna appare per un repo INTERO (nessun filtro)", async () => {
    const user = userEvent.setup();
    // Widget esistente con REPO_A abilitato e NESSUN filtro (repo intero) → interno.
    renderSection([makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: {} })]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.getByText(/This widget exposes internal or unverified documentation/i),
    ).toBeInTheDocument();
  });

  it("il warning appare quando i kinds includono functional", async () => {
    const user = userEvent.setup();
    const savedFilters = {
      [REPO_A]: { paths: [], slugs: [], kinds: ["functional" as const] },
    };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.getByText(/This widget exposes internal or unverified documentation/i),
    ).toBeInTheDocument();
  });

  it("il warning appare quando c'è una selezione fine per paths (ignora il kind)", async () => {
    const user = userEvent.setup();
    const savedFilters = { [REPO_A]: { paths: ["apps/webapp"], slugs: [], kinds: [] } };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.getByText(/This widget exposes internal or unverified documentation/i),
    ).toBeInTheDocument();
  });

  it("NESSUN warning quando l'entry è solo kinds=[\"product\"]", async () => {
    const user = userEvent.setup();
    const savedFilters = {
      [REPO_A]: { paths: [], slugs: [], kinds: ["product" as const] },
    };
    renderSection([
      makeWidget({ enabledRepositoryIds: [REPO_A], repositoryFilters: savedFilters }),
    ]);

    await user.click(await screen.findByRole("button", { name: "Edit" }));

    expect(
      screen.queryByText(/This widget exposes internal or unverified documentation/i),
    ).not.toBeInTheDocument();
  });

  it("«Copy guide» copia la guida markdown con il DSN del widget giusto", async () => {
    const user = userEvent.setup();
    // window.location.origin in happy-dom è http://localhost:3000 di default.
    renderSection([makeWidget({ name: "Landing", key: "widgetkey123" })]);

    await user.click(await screen.findByRole("button", { name: "Copy install guide" }));

    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('# Install the "Landing" support widget');
    expect(copied).toContain("widgetkey123@localhost:3000/p/acme");
    expect(copied).toContain("Option A");
    expect(copied).toContain("Option B");
    expect(copied).not.toContain("undefined");
  });

  it("il bottone «Download .md» crea un Blob e un anchor con il filename atteso", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    // Il click sull'anchor in happy-dom tenterebbe una navigazione al blob URL
    // (corrompe window.location per i test successivi): lo neutralizziamo e ne
    // catturiamo l'attributo `download` per verificare il filename atteso.
    let downloadAttr: string | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadAttr = this.download;
      });
    renderSection([makeWidget({ name: "Landing Help" })]);

    await user.click(await screen.findByRole("button", { name: "Download install guide (.md)" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloadAttr).toBe("stubwise-widget-landing-help.md");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    clickSpy.mockRestore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it("guida copia/scarica visibili anche ai member (la key è già esposta)", async () => {
    renderSection([makeWidget({ name: "Landing" })], false);

    expect(
      await screen.findByRole("button", { name: "Copy install guide" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download install guide (.md)" }),
    ).toBeInTheDocument();
  });

  it("ai member la sezione è in sola lettura: nessun New widget, editor disabilitato", async () => {
    const user = userEvent.setup();
    renderSection([makeWidget({ name: "Landing" })], false);

    await screen.findByText("Landing");
    expect(screen.queryByRole("button", { name: "New widget" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Enable the widget")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete widget" })).not.toBeInTheDocument();
    expect(
      screen.getByText("Only administrators can change these settings."),
    ).toBeInTheDocument();
  });
});
