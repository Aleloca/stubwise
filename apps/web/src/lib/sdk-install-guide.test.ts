import { describe, expect, it } from "vitest";
import { buildSdkInstallGuide, sdkGuideFilename } from "./sdk-install-guide";

/**
 * Generatore PURO della guida di installazione dell'SDK di error tracking
 * `@stubwise/sdk`: ritorna un markdown autocontenuto (nessun DOM) da incollare a
 * un agent AI sul servizio di destinazione. I valori (DSN, ingestion key, origin,
 * slug, endpoint, guide URL) sono REALI: ogni claim è verificabile sul sorgente
 * dell'SDK.
 */

const input = {
  projectSlug: "acme-shop",
  projectName: "Acme Shop",
  ingestionKey: "ikey-abc-123",
  origin: "https://track.example.com",
};

const dsn = "https://ikey-abc-123@track.example.com/p/acme-shop";

describe("buildSdkInstallGuide", () => {
  it("intitola con il nome del progetto e dà il contesto Stubwise error tracking", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain('# Install Stubwise error tracking in "Acme Shop"');
    expect(md.toLowerCase()).toContain("stubwise");
    expect(md.toLowerCase()).toContain("error tracking");
    expect(md.toLowerCase()).toContain("ticket");
  });

  it("elenca i key facts REALI: origin, project, ingestion key, DSN, endpoint, npm, guide", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain("https://track.example.com");
    expect(md).toContain("Acme Shop");
    expect(md).toContain("acme-shop");
    expect(md).toContain("ikey-abc-123");
    expect(md).toContain(dsn);
    expect(md).toContain("https://track.example.com/ingest/acme-shop");
    expect(md).toContain("@stubwise/sdk");
    expect(md).toContain("https://track.example.com/guide/sdk/installation/");
  });

  it("costruisce il DSN col protocol dell'origin (http resta http)", () => {
    const md = buildSdkInstallGuide({ ...input, origin: "http://localhost:5173" });
    expect(md).toContain("http://ikey-abc-123@localhost:5173/p/acme-shop");
  });

  it("Browser: npm install + import da @stubwise/sdk/browser con init e DSN reale", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain("npm install @stubwise/sdk");
    expect(md).toContain('import { init } from "@stubwise/sdk/browser"');
    expect(md).toContain(`dsn: "${dsn}"`);
  });

  it("Browser: descrive SOLO l'auto-instrumentazione reale (error, unhandledrejection, breadcrumb, flush keepalive)", () => {
    const md = buildSdkInstallGuide(input).toLowerCase();
    expect(md).toContain("unhandledrejection");
    expect(md).toContain("breadcrumb");
    expect(md).toContain("click");
    expect(md).toContain("navigation");
    expect(md).toContain("pagehide");
    expect(md).toContain("keepalive");
  });

  it("Browser: mostra le API opzionali con firme reali (captureFeedback screenshot, createTicket, addBreadcrumb)", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain("captureFeedback");
    expect(md).toContain("screenshot: true");
    expect(md).toContain("createTicket");
    expect(md).toContain("addBreadcrumb");
  });

  it("Node: sezione con import da @stubwise/sdk/node, init e middleware Express/Fastify reali", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain('import { init } from "@stubwise/sdk/node"');
    expect(md).toContain("registerProcessHandlers");
    expect(md).toContain("uncaughtException");
    expect(md).toContain("expressErrorHandler");
    expect(md).toContain("fastifyErrorHandler");
  });

  it("Behavior & guarantees: never-throw, batching/flush, retry — claim veri", () => {
    const md = buildSdkInstallGuide(input).toLowerCase();
    expect(md).toContain("never");
    expect(md).toContain("malformed dsn");
    expect(md).toContain("batch");
    expect(md).toContain("retr");
  });

  it("Verification steps: captureError di prova → ticket sdk_error nel progetto", () => {
    const md = buildSdkInstallGuide(input);
    expect(md.toLowerCase()).toContain("verif");
    expect(md).toContain('captureError(new Error("Stubwise test error"))');
    expect(md).toContain("sdk_error");
  });

  it("Verification: curl opzionale valido verso l'endpoint ingest con header e schema corretti", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).toContain('curl -X POST "https://track.example.com/ingest/acme-shop"');
    expect(md).toContain('-H "X-Stubwise-Key: ikey-abc-123"');
    // il body deve rispettare lo schema errorEventSchema: kind, message,
    // breadcrumbs (array), timestamp ISO.
    expect(md).toContain('"kind":"error"');
    expect(md).toContain('"breadcrumbs":[]');
    expect(md).toContain('"timestamp"');
  });

  it("Security note: la ingestion key è publishable, scoped al progetto, UNA per progetto", () => {
    const md = buildSdkInstallGuide(input).toLowerCase();
    expect(md).toContain("publishable");
    expect(md).toContain("project");
    // a differenza del widget, una sola chiave per progetto
    expect(md).toContain("one ingestion key");
  });

  it("sanitizza il nome del progetto con newline nel titolo e nei key facts", () => {
    const md = buildSdkInstallGuide({ ...input, projectName: "Acme\n  Shop" });
    expect(md).toContain('# Install Stubwise error tracking in "Acme Shop"');
    expect(md).toContain("- Project name: Acme Shop");
    expect(md).not.toContain("Acme\n");
  });

  it("non contiene mai le stringhe letterali undefined o null (input realistico)", () => {
    const md = buildSdkInstallGuide(input);
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("null");
  });
});

describe("sdkGuideFilename", () => {
  it("produce uno slug filesystem-safe dallo slug del progetto", () => {
    expect(sdkGuideFilename("acme-shop")).toBe("stubwise-sdk-acme-shop.md");
    expect(sdkGuideFilename("Café / Support!")).toBe("stubwise-sdk-caf-support.md");
  });

  it("ripiega su un default quando lo slug non ha caratteri utili", () => {
    expect(sdkGuideFilename("###")).toBe("stubwise-sdk-project.md");
  });
});
