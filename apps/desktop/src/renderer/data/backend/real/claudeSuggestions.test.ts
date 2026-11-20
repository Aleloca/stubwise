import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissClaudeSuggestion, getClaudeSuggestion } from "./claudeSuggestions";
import { setAppClientForTests } from "./client";
import { installFakeServer, PROJECT_ID } from "./fakeServer";

// «Claude can help you…» nella build app (area 10, F7 di 72): la riga la
// decide il server per chi guarda (`GET /api/claude/suggestions`, budget,
// «Not now», permessi e dati); il renderer la mostra con le frasi del
// prototipo e non deduce niente. «Not now» la salva il server per persona e
// per oggetto (`POST …/dismiss`, 204).

const REPO = "11111111-1111-4111-8111-111111111111";
const row = (over: Record<string, unknown> = {}) => ({
  suggestionId: `buildAutomation:${PROJECT_ID}`,
  kind: "buildAutomation",
  page: "automations",
  objectId: PROJECT_ID,
  params: { code: "AUD" },
  ...over,
});

beforeEach(() => {
  setAppClientForTests(null);
  vi.stubEnv("VITE_STUBWISE_BUILD", "app");
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppClientForTests(null);
});

const query = (path: string) => Object.fromEntries(new URL(`http://x${path}`).searchParams);

describe("la riga «Claude can help you…» dal server", () => {
  it("la pagina e l'oggetto nella query; la riga nella forma del prototipo, col codice dell'oggetto", async () => {
    const { seen } = installFakeServer({ "GET /api/claude/suggestions": { body: row() } });
    expect(await getClaudeSuggestion({ kind: "automations", projectId: PROJECT_ID })).toEqual({
      id: "buildAutomation",
      lineKey: "claude.suggestions.buildAutomation.line",
      promptKey: "claude.suggestions.buildAutomation.prompt",
      params: { code: "AUD" },
    });
    expect(query(seen[0]!.path)).toEqual({ page: "automations", objectId: PROJECT_ID });
    await getClaudeSuggestion({ kind: "overview", projectId: PROJECT_ID });
    expect(query(seen[1]!.path)).toEqual({ page: "overview", objectId: PROJECT_ID });
    await getClaudeSuggestion({ kind: "usage" });
    expect(query(seen[2]!.path)).toEqual({ page: "usage" });
  });

  it("la PR come `<repository>:<numero>` (l'id della build app è `<repository>#<numero>`)", async () => {
    const { seen } = installFakeServer({
      "GET /api/claude/suggestions": {
        body: row({ kind: "releaseNotes", page: "pr", params: {} }),
      },
    });
    const s = await getClaudeSuggestion({ kind: "pr", prId: `${REPO}#246` });
    expect(s).toMatchObject({ id: "releaseNotes" });
    expect(s!.params).toBeUndefined();
    expect(query(seen[0]!.path)).toEqual({ page: "pr", objectId: `${REPO}:246` });
  });

  it("nessuna riga (null), un tipo ignoto, una PR senza numero, un server senza la rotta: niente", async () => {
    installFakeServer({ "GET /api/claude/suggestions": { body: null } });
    expect(await getClaudeSuggestion({ kind: "usage" })).toBeNull();
    installFakeServer({ "GET /api/claude/suggestions": { body: row({ kind: "teleport" }) } });
    expect(await getClaudeSuggestion({ kind: "usage" })).toBeNull();
    const { seen } = installFakeServer({});
    expect(await getClaudeSuggestion({ kind: "pr", prId: `${REPO}#0` })).toBeNull();
    expect(seen).toEqual([]);
    expect(await getClaudeSuggestion({ kind: "usage" })).toBeNull();
  });

  it("«Not now»: il tipo e l'oggetto al server", async () => {
    const { seen } = installFakeServer({ "POST /api/claude/suggestions/dismiss": { status: 204 } });
    await dismissClaudeSuggestion({ kind: "pr", prId: `${REPO}#246` }, "releaseNotes");
    await dismissClaudeSuggestion({ kind: "usage" }, "monthSpend");
    expect(seen.map((r) => r.body)).toEqual([
      { kind: "releaseNotes", objectId: `${REPO}:246` },
      { kind: "monthSpend", objectId: "" },
    ]);
  });
});
