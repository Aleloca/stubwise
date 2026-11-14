import { ApiError } from "@stubwise/api-client";
import type { WidgetAdmin } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { createRealWidgets, type WidgetsApi } from "./supportWidgets";

// Area 8, F3 (R1/R2): i widget di Support sulle rotte di oggi (quelle del
// web, `client.widgets` di 72), con le firme del prototipo. La PUT è una
// SOSTITUZIONE: si manda il corpo intero, filtri dei repository compresi.

const PRJ = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222222";
const REPO = "33333333-3333-4333-8333-333333333333";
const OTHER_REPO = "44444444-4444-4444-8444-444444444444";

const widget = (over: Partial<WidgetAdmin> = {}): WidgetAdmin => ({
  id: W1,
  name: "Portal help",
  key: "wk_public_123",
  enabled: true,
  enabledRepositoryIds: [REPO],
  repositoryFilters: { [REPO]: { paths: ["docs"], slugs: [], kinds: [] } },
  title: "Help",
  welcomeMessage: "Hi!",
  instructions: "",
  accentColor: "#0e7490",
  language: "en",
  dailyMessageCap: null,
  dailyTicketCap: 20,
  origins: [],
  createdAt: "2026-11-01T09:00:00.000Z",
  conversationCount: 3,
  ...over,
});

function fakeApi(over: Partial<WidgetsApi> = {}) {
  const calls: { op: string; body?: unknown }[] = [];
  const api: WidgetsApi = {
    list: async () => ({ widgets: [widget()], canManage: true }),
    create: async (_p, body) => {
      calls.push({ op: "create", body });
      return {
        widget: widget({ id: "55555555-5555-4555-8555-555555555555", ...(body as object) }),
      };
    },
    update: async (projectId, widgetId, body) => {
      calls.push({ op: `update ${projectId} ${widgetId}`, body });
      return { widget: widget(body as Partial<WidgetAdmin>) };
    },
    remove: async (projectId, widgetId) => {
      calls.push({ op: `delete ${projectId} ${widgetId}` });
    },
    ...over,
  };
  return { api, calls };
}

const origin = async () => "https://stubwise.acme.test";

describe("i widget di Support dal server (area 8, F3)", () => {
  it("l'elenco nella forma del prototipo: i nomi del web tradotti, la chiave e l'origine vera per lo snippet", async () => {
    const { api } = fakeApi();
    const list = await createRealWidgets(api, origin).listWidgets(PRJ);
    expect(list.canManage).toBe(true);
    expect(list.widgets[0]).toMatchObject({
      id: W1,
      projectId: PRJ,
      name: "Portal help",
      sourceRepositoryIds: [REPO],
      origins: [],
      dailyRequestCap: 20,
      conversationCount: 3,
      key: "wk_public_123",
      snippetOrigin: "https://stubwise.acme.test",
    });
  });

  it("senza widget.manage la sezione non c'è: nessun widget, come nel prototipo", async () => {
    const { api } = fakeApi({ list: async () => ({ widgets: [widget()], canManage: false }) });
    expect(await createRealWidgets(api, origin).listWidgets(PRJ)).toEqual({
      canManage: false,
      widgets: [],
    });
  });

  it("modificare manda il corpo INTERO, coi filtri dei repository di prima (la PUT sostituisce)", async () => {
    const { api, calls } = fakeApi();
    const widgets = createRealWidgets(api, origin);
    await widgets.listWidgets(PRJ);
    const saved = await widgets.updateWidget(W1, { name: "Portal help 2" });
    expect(calls).toEqual([
      {
        op: `update ${PRJ} ${W1}`,
        body: {
          name: "Portal help 2",
          enabled: true,
          enabledRepositoryIds: [REPO],
          repositoryFilters: { [REPO]: { paths: ["docs"], slugs: [], kinds: [] } },
          title: "Help",
          welcomeMessage: "Hi!",
          instructions: "",
          accentColor: "#0e7490",
          language: "en",
          dailyMessageCap: null,
          dailyTicketCap: 20,
        },
      },
    ]);
    expect(saved.name).toBe("Portal help 2");
  });

  it("togliendo un repository se ne tolgono anche i filtri (altrimenti 422)", async () => {
    const { api, calls } = fakeApi();
    const widgets = createRealWidgets(api, origin);
    await widgets.listWidgets(PRJ);
    await widgets.updateWidget(W1, { sourceRepositoryIds: [OTHER_REPO] });
    const body = calls[0]!.body as { enabledRepositoryIds: string[]; repositoryFilters: object };
    expect(body.enabledRepositoryIds).toEqual([OTHER_REPO]);
    expect(body.repositoryFilters).toEqual({});
  });

  it("creare: i campi del prototipo coi nomi del web, coi siti ammessi (area 8, F3)", async () => {
    const { api, calls } = fakeApi();
    await createRealWidgets(api, origin).createWidget(PRJ, {
      name: "Site",
      origins: ["https://acq.test"],
      dailyRequestCap: 5,
    });
    expect(calls[0]!.body).toMatchObject({
      name: "Site",
      dailyTicketCap: 5,
      enabledRepositoryIds: [],
    });
    expect((calls[0]!.body as { repositoryFilters: object }).repositoryFilters).toEqual({});
    expect(calls[0]!.body).toMatchObject({ origins: ["https://acq.test"] });
  });

  it("i siti ammessi: si leggono dal server; una modifica che non li tocca non li manda (il server li tiene)", async () => {
    const { api, calls } = fakeApi({
      list: async () => ({
        widgets: [widget({ origins: ["https://shop.test"] })],
        canManage: true,
      }),
    });
    const widgets = createRealWidgets(api, origin);
    const [w] = (await widgets.listWidgets(PRJ)).widgets;
    expect(w!.origins).toEqual(["https://shop.test"]);
    await widgets.updateWidget(W1, { title: "Ask us" });
    expect(calls[0]!.body).not.toHaveProperty("origins");
    await widgets.updateWidget(W1, { origins: [] });
    expect(calls[1]!.body).toMatchObject({ origins: [] });
  });

  it("eliminare usa il progetto del widget; un widget mai letto è not_found", async () => {
    const { api, calls } = fakeApi();
    const widgets = createRealWidgets(api, origin);
    await expect(widgets.deleteWidget(W1)).rejects.toThrow("not_found");
    await widgets.listWidgets(PRJ);
    await widgets.deleteWidget(W1);
    expect(calls).toEqual([{ op: `delete ${PRJ} ${W1}` }]);
  });

  it("un repository fuori dal progetto (422) nelle parole del prototipo", async () => {
    const { api } = fakeApi({
      create: async () => {
        throw new ApiError(422, "validation", "validation");
      },
    });
    await expect(createRealWidgets(api, origin).createWidget(PRJ, { name: "x" })).rejects.toThrow(
      "invalid",
    );
  });
});
