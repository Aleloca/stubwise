import { describe, expect, it } from "vitest";
import { widgetGuide, widgetSnippet } from "./widgetSnippet";

// Lo snippet di un widget (area 8, F3): nel prototipo un'istanza finta e l'id
// al posto della chiave; nella build app l'indirizzo vero dell'istanza e la
// chiave pubblica del widget.

const base = {
  id: "wdg-1",
  projectId: "prj-1",
  name: "Portal help",
  enabled: true,
  sourceRepositoryIds: [],
  origins: [],
  title: "Help",
  welcomeMessage: "Hi!",
  instructions: "",
  accentColor: "#0e7490",
  language: "en" as const,
  dailyMessageCap: null,
  dailyRequestCap: null,
  createdAt: "2026-11-01T09:00:00.000Z",
};

describe("lo snippet di un widget", () => {
  it("nel prototipo: l'istanza finta e l'id", () => {
    expect(widgetSnippet(base)).toContain(
      'dsn: "https://stubwise.example.com/widget/prj-1?key=wdg-1"',
    );
  });

  it("nella build app: l'istanza vera e la chiave pubblica, anche nella guida", () => {
    const w = { ...base, key: "wk_public_123", snippetOrigin: "https://stubwise.acme.test" };
    const snippet = widgetSnippet(w);
    expect(snippet).toContain('<script src="https://stubwise.acme.test/widget.js" defer></script>');
    expect(snippet).toContain('dsn: "https://stubwise.acme.test/widget/prj-1?key=wk_public_123"');
    expect(snippet).not.toContain("stubwise.example.com");
    expect(widgetGuide(w)).toContain("https://stubwise.acme.test/widget/prj-1?key=wk_public_123");
    // Il server non ha i siti ammessi: la guida non li nomina.
    expect(widgetGuide(w)).not.toContain("Allowed sites");
    expect(widgetGuide(base)).toContain("Allowed sites");
  });
});
