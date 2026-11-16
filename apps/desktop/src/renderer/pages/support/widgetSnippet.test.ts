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
  identitySecretSet: false,
  identitySecretRotatedAt: null,
  identityRequired: false,
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
  });

  it("i siti ammessi nella guida, anche nella build app (area 8, F3); elenco vuoto: qualunque sito", () => {
    const w = { ...base, key: "wk_public_123", snippetOrigin: "https://stubwise.acme.test" };
    expect(widgetGuide(w)).toContain("- Allowed sites: any site (the list is empty)");
    expect(widgetGuide({ ...w, origins: ["https://shop.acme.test"] })).toContain(
      "- Allowed sites: `https://shop.acme.test`",
    );
  });
});
