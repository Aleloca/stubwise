import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import type { DocTreeNode } from "../lib/docs-api";
import { WidgetSectionFilter } from "./widget-section-filter";

/**
 * Filtro FINE per-repo nell'editor widget: albero Docs on-demand RAGGRUPPATO per
 * kind (technical/functional/manual/releases), con header di gruppo collassabile
 * e checkbox sul gruppo intero (→ `kinds`), più selezione a checkbox dei nodi
 * (prefissi di sourcePath per i nodi con percorso, slug puntuali per le pagine
 * manuali). `getDocTree` è mockato; ogni test semina la sua foresta.
 */

const getDocTree = vi.fn();

vi.mock("../lib/docs-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docs-api")>();
  return { ...actual, getDocTree: (...args: unknown[]) => getDocTree(...args) };
});

const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Filter = { paths: string[]; slugs: string[]; kinds: DocTreeNode["kind"][] };

function node(overrides: Partial<DocTreeNode> & { id: string }): DocTreeNode {
  return {
    slug: overrides.id,
    title: overrides.id,
    kind: "technical",
    parentId: null,
    position: 0,
    sourcePath: null,
    isManual: false,
    ...overrides,
  };
}

function renderFilter(props: {
  value?: Filter;
  onChange?: (v: Filter | undefined) => void;
  disabled?: boolean;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = props.onChange ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <WidgetSectionFilter
        repositoryId={REPO_ID}
        repositoryName="web"
        value={props.value}
        onChange={onChange}
        disabled={props.disabled}
      />
    </QueryClientProvider>,
  );
  return { onChange };
}

/**
 * Espande il gruppo del kind dato cliccandone il chevron. I gruppi partono
 * COLLASSATI quando non hanno selezioni fini dentro: molti test devono espanderli
 * per interagire coi nodi. Il chevron ha aria-label = docs:space.expand("<Label>").
 */
async function expandGroup(user: ReturnType<typeof userEvent.setup>, label: string) {
  const chevron = await screen.findByRole("button", { name: new RegExp(`expand.*${label}`, "i") });
  await user.click(chevron);
}

afterEach(() => getDocTree.mockReset());

describe("WidgetSectionFilter", () => {
  it("apre l'albero on-demand e rende i nodi raggruppati sotto l'header del kind", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "technical", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({});

    // Chiuso di default (nessun filtro): l'albero non è ancora caricato.
    expect(getDocTree).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /limit to sections/i }));

    // Header del gruppo Technical presente; il nodo appare espandendo il gruppo.
    expect(await screen.findByRole("button", { name: /expand.*technical/i })).toBeInTheDocument();
    await expandGroup(user, "Technical");
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
    expect(getDocTree).toHaveBeenCalledWith(REPO_ID);
  });

  it("aperto di default se un filtro esiste già", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });
    // Il blocco è aperto; il gruppo Technical c'è (espandibile).
    expect(await screen.findByRole("button", { name: /expand.*technical/i })).toBeInTheDocument();
    await expandGroup(user, "Technical");
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
  });

  it("le pagine sono renderizzate sotto l'header del proprio kind", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "arch", title: "Architecture", kind: "technical", sourcePath: "src" }),
      node({ id: "guide", title: "User guide", kind: "functional", isManual: true }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    // Entrambi gli header ci sono; espandendo ciascun gruppo vedo la sua pagina.
    await expandGroup(user, "Technical");
    expect(await screen.findByText("Architecture")).toBeInTheDocument();
    await expandGroup(user, "Functional");
    expect(await screen.findByText("User guide")).toBeInTheDocument();
  });

  it("spunta un nodo con sourcePath → onChange con il path (kinds preservato)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({});

    await user.click(screen.getByRole("button", { name: /limit to sections/i }));
    await expandGroup(user, "Technical");
    await user.click(await screen.findByLabelText("Webapp"));

    expect(onChange).toHaveBeenLastCalledWith({ paths: ["apps/webapp"], slugs: [], kinds: [] });
  });

  it("spunta una pagina manuale (senza sourcePath) → onChange con lo slug", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "faq", slug: "faq", title: "FAQ", kind: "manual", isManual: true }),
    ]);
    const { onChange } = renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    await expandGroup(user, "Manual");
    await user.click(await screen.findByLabelText("FAQ"));
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: ["faq"], kinds: [] });
  });

  it("de-spunta un path selezionato → rimosso", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    // Gruppo con selezione fine dentro → espanso di default.
    const checkbox = await screen.findByLabelText("Webapp");
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: [], kinds: [] });
  });

  it("spuntare l'antenato pota i discendenti già selezionati (paths ridondanti rimossi)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    // apps/webapp già selezionato: spuntare `apps` lo pota (è coperto).
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    await user.click(await screen.findByLabelText("Apps"));
    expect(onChange).toHaveBeenLastCalledWith({ paths: ["apps"], slugs: [], kinds: [] });
  });

  it("il nodo antenato è indeterminate quando solo un discendente è selezionato", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    const parent = (await screen.findByLabelText("Apps")) as HTMLInputElement;
    expect(parent.indeterminate).toBe(true);
    expect(parent.checked).toBe(false);
  });

  it("un nodo coperto da un ANTENATO selezionato è checked + disabilitato", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" }),
      node({ id: "child", parentId: "root", title: "Login", sourcePath: "apps/webapp/login" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    const child = await screen.findByLabelText("Login");
    expect(child).toBeChecked();
    expect(child).toBeDisabled();
    expect(child).toHaveAttribute("title", expect.stringContaining("apps/webapp"));
  });

  it("«Rimuovi filtro» → onChange(undefined)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    await user.click(await screen.findByRole("button", { name: "Remove filter" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("warning quando il filtro esiste ma è vuoto (paths+slugs+kinds vuoti)", async () => {
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    expect(
      await screen.findByText(/The widget will expose nothing from web/i),
    ).toBeInTheDocument();
  });

  it("albero vuoto → messaggio «nessuna documentazione»", async () => {
    getDocTree.mockResolvedValue([]);
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    expect(
      await screen.findByText(/No documentation generated for this repository/i),
    ).toBeInTheDocument();
  });

  it("404 dall'endpoint tree → messaggio «nessuna documentazione», nessun crash", async () => {
    getDocTree.mockRejectedValue(new ApiError(404, "not found", "not_found"));
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    await waitFor(() =>
      expect(
        screen.getByText(/No documentation generated for this repository/i),
      ).toBeInTheDocument(),
    );
  });

  it("errore generico (500) → messaggio d'errore distinto, non «nessuna doc»", async () => {
    getDocTree.mockRejectedValue(new ApiError(500, "boom", "internal_error"));
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    expect(
      await screen.findByText(/Could not load the documentation tree/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No documentation generated for this repository/i),
    ).not.toBeInTheDocument();
  });

  it("errore di rete (status 0) → messaggio d'errore distinto", async () => {
    getDocTree.mockRejectedValue(new ApiError(0, "network"));
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    expect(
      await screen.findByText(/Could not load the documentation tree/i),
    ).toBeInTheDocument();
  });

  // --- Selezione di GRUPPO (kind) ---

  it("spunta l'header di gruppo → onChange con kinds e paths/slugs del gruppo potati", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "functional", sourcePath: "apps/webapp" }),
      node({ id: "faq", slug: "faq", title: "FAQ", kind: "functional", isManual: true }),
    ]);
    // Selezioni fini dentro il gruppo functional: spuntare il gruppo le pota.
    const { onChange } = renderFilter({
      value: { paths: ["apps/webapp"], slugs: ["faq"], kinds: [] },
    });

    // Header del gruppo Functional (label uppercase → aria-label "Functional").
    await user.click(await screen.findByLabelText("Functional"));
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: [], kinds: ["functional"] });
  });

  it("un nodo sotto un gruppo selezionato è checked + disabled con title del gruppo", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "functional", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: ["functional"] } });

    // Gruppo selezionato → espanso di default (mostra i nodi coperti).
    const child = await screen.findByLabelText("Webapp");
    expect(child).toBeChecked();
    expect(child).toBeDisabled();
    expect(child).toHaveAttribute("title", expect.stringContaining("Functional"));
  });

  it("header indeterminate quando c'è una selezione fine dentro ma il kind non è selezionato", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "functional", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    const header = (await screen.findByLabelText("Functional")) as HTMLInputElement;
    expect(header.checked).toBe(false);
    expect(header.indeterminate).toBe(true);
  });

  it("nodo indeterminate → spunta del gruppo → l'indeterminate DOM viene resettato (checked, non trattino)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", kind: "technical", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    // Il componente è controllato: uso un wrapper con stato per rialimentare
    // il valore emesso dal click sul gruppo e osservare il re-render del nodo.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const [value, setValue] = useState<Filter | undefined>({
        paths: ["apps/webapp"],
        slugs: [],
        kinds: [],
      });
      return (
        <WidgetSectionFilter
          repositoryId={REPO_ID}
          repositoryName="web"
          value={value}
          onChange={setValue}
        />
      );
    }
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );

    // Solo il discendente selezionato → il padre "Apps" parte indeterminate.
    const parent = (await screen.findByLabelText("Apps")) as HTMLInputElement;
    expect(parent.indeterminate).toBe(true);

    // Spunto il GRUPPO (kind technical) → i nodi sono coperti dal gruppo.
    await user.click(await screen.findByLabelText("Technical"));

    const coveredParent = (await screen.findByLabelText("Apps")) as HTMLInputElement;
    expect(coveredParent.checked).toBe(true);
    expect(coveredParent.indeterminate).toBe(false);
  });

  it("kinds pieni ma paths/slugs vuoti → NESSUN warning di entry vuota", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "technical", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: ["technical"] } });

    await screen.findByLabelText("Technical");
    expect(screen.queryByText(/The widget will expose nothing from web/i)).not.toBeInTheDocument();
  });

  it("header checked quando il kind è nel filtro in ingresso (rendering da salvato)", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "functional", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: ["functional"] } });

    const header = (await screen.findByLabelText("Functional")) as HTMLInputElement;
    expect(header.checked).toBe(true);
  });

  it("unspunta il gruppo → kind rimosso, nessuna resurrezione delle selezioni fini", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "functional", sourcePath: "apps/webapp" }),
    ]);
    const { onChange } = renderFilter({
      value: { paths: [], slugs: [], kinds: ["functional"] },
    });

    await user.click(await screen.findByLabelText("Functional"));
    // Solo il kind rimosso: paths/slugs restano vuoti (niente resurrezione).
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: [], kinds: [] });
  });

  // --- Collapse / expand ---

  it("il gruppo è collassato di default (nessuna selezione) e si espande col chevron", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "technical", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    // Collassato: il nodo non è nel DOM finché non espando.
    await screen.findByRole("button", { name: /expand.*technical/i });
    expect(screen.queryByText("Webapp")).not.toBeInTheDocument();
    await expandGroup(user, "Technical");
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
  });

  it("il gruppo è espanso di default quando ha una selezione fine dentro", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", kind: "technical", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });
    // Espanso: il nodo è già visibile senza cliccare.
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
  });

  it("un nodo con figli si collassa/espande col proprio chevron", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", kind: "technical", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [], kinds: [] } });

    // Il gruppo è espanso (selezione fine); il figlio è visibile.
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
    // Collasso il nodo "Apps" col suo chevron → il figlio sparisce.
    const nodeChevron = await screen.findByRole("button", { name: /collapse.*Apps/i });
    await user.click(nodeChevron);
    expect(screen.queryByText("Webapp")).not.toBeInTheDocument();
  });

  // --- Normalizzazione dei sourcePath con slash finale ---
  // Il docs-engine produce sourcePath di directory in modo INCOERENTE: alcune
  // radici/directory arrivano con slash finale (es. "audin-api/src/controllers/")
  // altre senza. Con lo slash finale grezzo `pathCovers` si romperebbe
  // (startsWith("a/b//")) e il prefisso salvato verrebbe respinto dallo schema.
  // Il componente normalizza il path al confine di lettura del nodo.

  it("spunta un padre-directory con slash finale → onChange con path normalizzato, figli coperti", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "ctrl", title: "Controllers", sourcePath: "audin-api/src/controllers/" }),
      node({
        id: "accounts",
        parentId: "ctrl",
        title: "accounts",
        sourcePath: "audin-api/src/controllers/accounts.controller.ts",
      }),
      node({
        id: "campaigns",
        parentId: "ctrl",
        title: "campaigns",
        sourcePath: "audin-api/src/controllers/campaigns.controller.ts",
      }),
    ]);
    const { onChange } = renderFilter({ value: { paths: [], slugs: [], kinds: [] } });

    await expandGroup(user, "Technical");
    await user.click(await screen.findByLabelText("Controllers"));
    // Il path emesso è normalizzato (senza slash finale): sarebbe accettato dallo schema.
    expect(onChange).toHaveBeenLastCalledWith({
      paths: ["audin-api/src/controllers"],
      slugs: [],
      kinds: [],
    });
  });

  it("padre-directory con slash finale coperto da filtro salvato normalizzato → checked, figli coperti+disabled", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "ctrl", title: "Controllers", sourcePath: "audin-api/src/controllers/" }),
      node({
        id: "accounts",
        parentId: "ctrl",
        title: "accounts",
        sourcePath: "audin-api/src/controllers/accounts.controller.ts",
      }),
    ]);
    renderFilter({ value: { paths: ["audin-api/src/controllers"], slugs: [], kinds: [] } });

    const parent = (await screen.findByLabelText("Controllers")) as HTMLInputElement;
    expect(parent.checked).toBe(true);

    const child = await screen.findByLabelText("accounts");
    expect(child).toBeChecked();
    expect(child).toBeDisabled();
  });

  it("potatura mista: figlio già selezionato, spunta del padre-con-slash → solo il padre normalizzato", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "ctrl", title: "Controllers", sourcePath: "audin-api/src/controllers/" }),
      node({
        id: "accounts",
        parentId: "ctrl",
        title: "accounts",
        sourcePath: "audin-api/src/controllers/accounts.controller.ts",
      }),
    ]);
    // Il figlio è già selezionato singolarmente: spuntare il padre lo pota.
    const { onChange } = renderFilter({
      value: {
        paths: ["audin-api/src/controllers/accounts.controller.ts"],
        slugs: [],
        kinds: [],
      },
    });

    await user.click(await screen.findByLabelText("Controllers"));
    expect(onChange).toHaveBeenLastCalledWith({
      paths: ["audin-api/src/controllers"],
      slugs: [],
      kinds: [],
    });
  });

  it("il riepilogo include gruppi, sezioni e pagine con plurali", async () => {
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    renderFilter({
      value: { paths: ["a", "b"], slugs: ["faq"], kinds: ["functional"] },
    });
    // Toggle mostra il riepilogo: 1 group, 2 sections, 1 page.
    expect(await screen.findByText(/1 group, 2 sections, 1 page/i)).toBeInTheDocument();
  });
});
