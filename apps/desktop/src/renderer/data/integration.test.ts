import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SECTIONS, APP_ROUTES, PROJECT_SECTIONS, PROJECT_SETTINGS_SECTIONS } from "./routes";
import { integrationTargetOf, isIntegrated, landingSearch, type IntegrationTarget } from "./integration";

afterEach(() => vi.unstubAllEnvs());

const ALL: IntegrationTarget[] = [
  ...APP_ROUTES.map((name) => ({ kind: "destination", name }) as const),
  ...PROJECT_SECTIONS.map((s) => ({ kind: "projectSection", name: s.id }) as const),
  ...PROJECT_SETTINGS_SECTIONS.map((s) => ({ kind: "projectSettings", name: s.id }) as const),
  ...ADMIN_SECTIONS.map((s) => ({ kind: "admin", name: s.id }) as const),
  ...(["list", "board", "timeline"] as const).map((name) => ({ kind: "taskView", name }) as const),
  ...(
    [
      "notifications",
      "search",
      "task-detail",
      "new-task",
      "view-as",
      "claude-panel",
      "claude-assign",
      "planning-week",
      "my-week",
      "saved-filters",
      "department-home",
      "department-permissions",
      "portfolio",
      "refine",
      "claude",
      "claude-chat",
      "claude-actions",
      "claude-decisions",
    ] as const
  ).map((name) => ({ kind: "feature", name }) as const),
];

const key = (t: IntegrationTarget) => `${t.kind}:${t.name}`;

describe("isIntegrated", () => {
  it("nel prototipo è tutto integrato", () => {
    expect(ALL.filter((t) => !isIntegrated(t))).toEqual([]);
  });

  it("nella build app l'ossatura, le Tasks (fetta 1), Planning e La mia settimana (fetta 2), Home e filtri (fetta 3), Overview, Requests e Tutti i progetti (fetta 4), le sessioni di lavoro di Claude in lettura (area 3, 3a)", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(ALL.filter(isIntegrated).map(key).sort()).toEqual(
      [
        "destination:projects",
        "projectSection:tasks",
        "projectSettings:statuses",
        "admin:departments",
        "taskView:list",
        "taskView:board",
        "feature:notifications",
        "feature:search",
        "feature:task-detail",
        "feature:new-task",
        "destination:planning",
        "projectSection:planning",
        "taskView:timeline",
        "feature:planning-week",
        "feature:my-week",
        "destination:home",
        "destination:filters",
        "feature:saved-filters",
        "feature:department-home",
        "projectSection:overview",
        "projectSection:requests",
        "feature:portfolio",
        // Area 3, fetta 3a: la chat libera, le azioni e «Da decidere» restano fuori.
        "destination:claude",
        "feature:claude",
      ].sort(),
    );
  });

  it("/home?view=week è La mia settimana, /home la Home", () => {
    expect(integrationTargetOf("/home", { view: "week" })?.target).toEqual({ kind: "feature", name: "my-week" });
    expect(integrationTargetOf("/home")?.target).toEqual({ kind: "destination", name: "home" });
  });

  it("dalla fetta 3 si atterra sulla Home anche nella build app", () => {
    expect(landingSearch()).toEqual({});
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    expect(landingSearch()).toEqual({});
  });
});
