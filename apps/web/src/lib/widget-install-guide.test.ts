import { describe, expect, it } from "vitest";
import type { Widget } from "./api";
import { buildWidgetInstallGuide, widgetGuideFilename } from "./widget-install-guide";

/**
 * Generatore PURO della guida di installazione di un widget: ritorna un markdown
 * autocontenuto (nessun DOM) da incollare a un agent AI sul progetto di
 * destinazione. I valori (DSN, key, origin, slug, id, bundle/guide URL) sono
 * REALI: l'unico placeholder ammesso sono i campi del parametro `user`.
 */

function makeWidget(overrides: Partial<Widget> = {}): Widget {
  return {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Landing help",
    key: "wkey-abc-123",
    enabled: true,
    enabledRepositoryIds: [],
    repositoryFilters: {},
    title: "Assistenza",
    welcomeMessage: "Ciao!",
    accentColor: "#22c55e",
    language: "it",
    dailyMessageCap: null,
    dailyTicketCap: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    conversationCount: 3,
    ...overrides,
  };
}

const input = {
  widget: makeWidget(),
  projectSlug: "acme-shop",
  projectName: "Acme Shop",
  origin: "https://support.example.com",
};

const dsn = "https://wkey-abc-123@support.example.com/p/acme-shop";

describe("buildWidgetInstallGuide", () => {
  it("intitola con il nome del widget e dà il contesto Stubwise", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).toContain('# Install the "Landing help" support widget');
    expect(md.toLowerCase()).toContain("stubwise");
    expect(md.toLowerCase()).toContain("docs-grounded");
  });

  it("elenca i key facts REALI: origin, project, widget name/id, key, DSN, bundle, guide", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).toContain("https://support.example.com");
    expect(md).toContain("Acme Shop");
    expect(md).toContain("acme-shop");
    expect(md).toContain("Landing help");
    expect(md).toContain("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(md).toContain("wkey-abc-123");
    expect(md).toContain(dsn);
    expect(md).toContain("https://support.example.com/widget.js");
    expect(md).toContain("https://support.example.com/guide/integrations/widget/");
  });

  it("costruisce il DSN col protocol dell'origin (http resta http)", () => {
    const md = buildWidgetInstallGuide({ ...input, origin: "http://localhost:5173" });
    expect(md).toContain("http://wkey-abc-123@localhost:5173/p/acme-shop");
  });

  it("Option A: script tag con /widget.js, listener stubwise:ready e DSN interpolato", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).toContain("Option A");
    expect(md).toContain('<script src="https://support.example.com/widget.js" defer></script>');
    expect(md).toContain('window.addEventListener("stubwise:ready"');
    expect(md).toContain("Stubwise.initWidget({");
    expect(md).toContain(`dsn: "${dsn}"`);
    expect(md).toContain('user: { id: "REPLACE_USER_ID", email: "REPLACE_EMAIL", name: "REPLACE_NAME" }');
  });

  it("Option B: npm install + import initWidget + stessa chiamata col DSN reale", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).toContain("Option B");
    expect(md).toContain("npm install @stubwise/widget");
    expect(md).toContain('import { initWidget } from "@stubwise/widget"');
    expect(md).toContain(`dsn: "${dsn}"`);
  });

  it("spiega il parametro user: id obbligatorio, email/name opzionali, identità dichiarata", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md.toLowerCase()).toContain("user");
    expect(md.toLowerCase()).toContain("required");
    expect(md.toLowerCase()).toContain("optional");
    expect(md.toLowerCase()).toContain("authenticated");
  });

  it("include note su placement e comportamento (Shadow DOM, non rompe, doppia init no-op)", () => {
    const md = buildWidgetInstallGuide(input).toLowerCase();
    expect(md).toContain("shadow dom");
    expect(md).toContain("bottom-right");
    expect(md).toContain("never");
    expect(md).toContain("no-op");
    expect(md).toContain("cookie");
  });

  it("include la verifica col curl esatto verso /widget/<slug>/config", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).toContain("window.Stubwise");
    expect(md).toContain(
      'curl -H "X-Stubwise-Key: wkey-abc-123" https://support.example.com/widget/acme-shop/config',
    );
    expect(md).toContain('{"enabled":true');
  });

  it("include la nota di sicurezza sulla chiave publishable e revocabile", () => {
    const md = buildWidgetInstallGuide(input).toLowerCase();
    expect(md).toContain("publishable");
    expect(md).toContain("revoke");
  });

  it("non contiene mai le stringhe letterali undefined o null (widget realistico)", () => {
    const md = buildWidgetInstallGuide(input);
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  });
});

describe("widgetGuideFilename", () => {
  it("produce uno slug filesystem-safe dal nome del widget", () => {
    expect(widgetGuideFilename("Landing Help")).toBe("stubwise-widget-landing-help.md");
    expect(widgetGuideFilename("Café / Support!")).toBe("stubwise-widget-caf-support.md");
  });

  it("ripiega su un default quando il nome non ha caratteri utili", () => {
    expect(widgetGuideFilename("###")).toBe("stubwise-widget-widget.md");
  });
});
