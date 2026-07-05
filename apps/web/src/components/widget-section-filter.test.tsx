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
});
