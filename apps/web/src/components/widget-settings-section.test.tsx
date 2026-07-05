import type { WidgetSettings } from "@stubwise/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { widgetSettingsQueryOptions } from "../lib/queries";
import { WidgetSettingsSection } from "./widget-settings-section";

/**
 * Sezione "Widget di assistenza" del dettaglio progetto: toggle, checklist dei
 * repository (fonti del retrieval), campi title/welcome/accent/language e Save
 * via PUT. Il modulo `../lib/api` è mockato (putWidgetSettings); le impostazioni
 * iniziali si seminano nella cache di TanStack Query così `useSuspenseQuery`
 * risolve subito, senza toccare la rete.
 */

const putWidgetSettings = vi.fn();

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, putWidgetSettings: (...args: unknown[]) => putWidgetSettings(...args) };
});

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const REPO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const repositories = [
  { id: REPO_A, name: "web", slug: "acme-web" },
  { id: REPO_B, name: "api", slug: "acme-api" },
];

function makeSettings(overrides: Partial<WidgetSettings> = {}): WidgetSettings {
  return {
    enabled: true,
    enabledRepositoryIds: [REPO_A],
    title: "Assistenza",
    welcomeMessage: "Ciao!",
    accentColor: "#22c55e",
    language: "it",
    ...overrides,
  };
}

function renderSection(settings: WidgetSettings, isAdmin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(widgetSettingsQueryOptions(PROJECT_ID).queryKey, settings);
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div>loading</div>}>
        <WidgetSettingsSection
          projectId={PROJECT_ID}
          repositories={repositories}
          ingestionKey="key-abc-123"
          slug="acme"
          isAdmin={isAdmin}
        />
      </Suspense>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  putWidgetSettings.mockReset();
});

describe("WidgetSettingsSection", () => {
  it("mostra toggle, campi e checklist dei repository", async () => {
    renderSection(makeSettings());

    expect(await screen.findByLabelText("Enable the widget")).toBeChecked();
    expect(screen.getByLabelText("Title")).toHaveValue("Assistenza");
    expect(screen.getByLabelText("Welcome message")).toHaveValue("Ciao!");
    // Il repo A è nella whitelist iniziale, il B no.
    expect(screen.getByLabelText("web")).toBeChecked();
    expect(screen.getByLabelText("api")).not.toBeChecked();
  });

  it("il submit chiama putWidgetSettings coi valori aggiornati", async () => {
    const user = userEvent.setup();
    putWidgetSettings.mockResolvedValue(makeSettings({ title: "Aiuto", enabledRepositoryIds: [REPO_A, REPO_B] }));
    renderSection(makeSettings());

    const title = await screen.findByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Aiuto");
    await user.click(screen.getByLabelText("api"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putWidgetSettings).toHaveBeenCalledTimes(1));
    expect(putWidgetSettings).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        title: "Aiuto",
        enabled: true,
        enabledRepositoryIds: [REPO_A, REPO_B],
        language: "it",
      }),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("lo snippet contiene lo slug e la chiave di ingestion", async () => {
    renderSection(makeSettings());

    const snippet = await screen.findByTestId("widget-snippet");
    expect(snippet.textContent).toContain("/widget.js");
    expect(snippet.textContent).toContain("key-abc-123@");
    expect(snippet.textContent).toContain("/p/acme");
  });

  it("mostra il warning quando è abilitato senza fonti", async () => {
    renderSection(makeSettings({ enabled: true, enabledRepositoryIds: [] }));

    expect(
      await screen.findByText(
        "No source selected: the widget will reply that it has no information.",
      ),
    ).toBeInTheDocument();
  });

  it("non mostra il warning quando è disabilitato senza fonti", async () => {
    renderSection(makeSettings({ enabled: false, enabledRepositoryIds: [] }));

    await screen.findByLabelText("Enable the widget");
    expect(
      screen.queryByText("No source selected: the widget will reply that it has no information."),
    ).not.toBeInTheDocument();
  });

  it("traduce l'errore 422 invalid_repository dal server", async () => {
    const user = userEvent.setup();
    putWidgetSettings.mockRejectedValue(
      new ApiError(422, "enabledRepositoryIds must reference repositories", "invalid_repository"),
    );
    renderSection(makeSettings());

    await user.click(await screen.findByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("One or more selected repositories do not belong to this project"),
    ).toBeInTheDocument();
  });

  it("ai member la sezione è in sola lettura: nessun Save, campi disabilitati", async () => {
    renderSection(makeSettings(), false);

    expect(await screen.findByText("Only administrators can change these settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Enable the widget")).toBeDisabled();
  });
});
