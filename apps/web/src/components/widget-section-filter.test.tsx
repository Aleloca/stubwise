import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import type { DocTreeNode } from "../lib/docs-api";
import { WidgetSectionFilter } from "./widget-section-filter";

/**
 * Filtro FINE per-repo nell'editor widget: albero Docs on-demand con selezione a
 * checkbox (prefissi di sourcePath per i nodi con percorso, slug puntuali per le
 * pagine manuali). `getDocTree` è mockato; ogni test semina la sua foresta.
 */

const getDocTree = vi.fn();

vi.mock("../lib/docs-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/docs-api")>();
  return { ...actual, getDocTree: (...args: unknown[]) => getDocTree(...args) };
});

const REPO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
  value?: { paths: string[]; slugs: string[] };
  onChange?: (v: { paths: string[]; slugs: string[] } | undefined) => void;
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

afterEach(() => getDocTree.mockReset());

describe("WidgetSectionFilter", () => {
  it("apre l'albero on-demand e rende i nodi", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({});

    // Chiuso di default (nessun filtro): l'albero non è ancora caricato.
    expect(getDocTree).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /limit to sections/i }));

    expect(await screen.findByText("Webapp")).toBeInTheDocument();
    expect(getDocTree).toHaveBeenCalledWith(REPO_ID);
  });

  it("aperto di default se un filtro esiste già", async () => {
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    renderFilter({ value: { paths: [], slugs: [] } });
    expect(await screen.findByText("Webapp")).toBeInTheDocument();
  });

  it("spunta un nodo con sourcePath → onChange con il path", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({});

    await user.click(screen.getByRole("button", { name: /limit to sections/i }));
    await user.click(await screen.findByLabelText("Webapp"));

    expect(onChange).toHaveBeenLastCalledWith({ paths: ["apps/webapp"], slugs: [] });
  });

  it("spunta una pagina manuale (senza sourcePath) → onChange con lo slug", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "faq", slug: "faq", title: "FAQ", isManual: true })]);
    const { onChange } = renderFilter({ value: { paths: [], slugs: [] } });

    await user.click(await screen.findByLabelText("FAQ"));
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: ["faq"] });
  });

  it("de-spunta un path selezionato → rimosso", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [] } });

    const checkbox = await screen.findByLabelText("Webapp");
    expect(checkbox).toBeChecked();
    await user.click(checkbox);
    expect(onChange).toHaveBeenLastCalledWith({ paths: [], slugs: [] });
  });

  it("spuntare l'antenato pota i discendenti già selezionati (paths ridondanti rimossi)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    // apps/webapp già selezionato: spuntare `apps` lo pota (è coperto).
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [] } });

    await user.click(await screen.findByLabelText("Apps"));
    expect(onChange).toHaveBeenLastCalledWith({ paths: ["apps"], slugs: [] });
  });

  it("il nodo antenato è indeterminate quando solo un discendente è selezionato", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Apps", sourcePath: "apps" }),
      node({ id: "child", parentId: "root", title: "Webapp", sourcePath: "apps/webapp" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [] } });

    const parent = (await screen.findByLabelText("Apps")) as HTMLInputElement;
    expect(parent.indeterminate).toBe(true);
    expect(parent.checked).toBe(false);
  });

  it("un nodo coperto da un ANTENATO selezionato è checked + disabilitato", async () => {
    getDocTree.mockResolvedValue([
      node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" }),
      node({ id: "child", parentId: "root", title: "Login", sourcePath: "apps/webapp/login" }),
    ]);
    renderFilter({ value: { paths: ["apps/webapp"], slugs: [] } });

    const child = await screen.findByLabelText("Login");
    expect(child).toBeChecked();
    expect(child).toBeDisabled();
    expect(child).toHaveAttribute("title", expect.stringContaining("apps/webapp"));
  });

  it("«Rimuovi filtro» → onChange(undefined)", async () => {
    const user = userEvent.setup();
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    const { onChange } = renderFilter({ value: { paths: ["apps/webapp"], slugs: [] } });

    await user.click(await screen.findByRole("button", { name: "Remove filter" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("warning quando il filtro esiste ma è vuoto (paths+slugs vuoti)", async () => {
    getDocTree.mockResolvedValue([node({ id: "root", title: "Webapp", sourcePath: "apps/webapp" })]);
    renderFilter({ value: { paths: [], slugs: [] } });

    expect(
      await screen.findByText(/The widget will expose nothing from web/i),
    ).toBeInTheDocument();
  });

  it("albero vuoto → messaggio «nessuna documentazione»", async () => {
    getDocTree.mockResolvedValue([]);
    renderFilter({ value: { paths: [], slugs: [] } });

    expect(
      await screen.findByText(/No documentation generated for this repository/i),
    ).toBeInTheDocument();
  });

  it("404 dall'endpoint tree → messaggio «nessuna documentazione», nessun crash", async () => {
    getDocTree.mockRejectedValue(new ApiError(404, "not found", "not_found"));
    renderFilter({ value: { paths: [], slugs: [] } });

    await waitFor(() =>
      expect(
        screen.getByText(/No documentation generated for this repository/i),
      ).toBeInTheDocument(),
    );
  });

  it("errore generico (500) → messaggio d'errore distinto, non «nessuna doc»", async () => {
    getDocTree.mockRejectedValue(new ApiError(500, "boom", "internal_error"));
    renderFilter({ value: { paths: [], slugs: [] } });

    expect(
      await screen.findByText(/Could not load the documentation tree/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No documentation generated for this repository/i),
    ).not.toBeInTheDocument();
  });

  it("errore di rete (status 0) → messaggio d'errore distinto", async () => {
    getDocTree.mockRejectedValue(new ApiError(0, "network"));
    renderFilter({ value: { paths: [], slugs: [] } });

    expect(
      await screen.findByText(/Could not load the documentation tree/i),
    ).toBeInTheDocument();
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
    const { onChange } = renderFilter({ value: { paths: [], slugs: [] } });

    await user.click(await screen.findByLabelText("Controllers"));
    // Il path emesso è normalizzato (senza slash finale): sarebbe accettato dallo schema.
    expect(onChange).toHaveBeenLastCalledWith({
      paths: ["audin-api/src/controllers"],
      slugs: [],
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
    renderFilter({ value: { paths: ["audin-api/src/controllers"], slugs: [] } });

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
      value: { paths: ["audin-api/src/controllers/accounts.controller.ts"], slugs: [] },
    });

    await user.click(await screen.findByLabelText("Controllers"));
    expect(onChange).toHaveBeenLastCalledWith({
      paths: ["audin-api/src/controllers"],
      slugs: [],
    });
  });
});
