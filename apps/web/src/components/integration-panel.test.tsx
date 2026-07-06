import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IntegrationPanel } from "./integration-panel";

/**
 * Pannello di integrazione del PROGETTO (Fase 3): chiave di ingestion, DSN
 * derivata dall'origin, snippet init() e webhook generico in ingresso, ciascuno
 * con il proprio bottone copia. Lo slug è quello del PROGETTO: gli endpoint
 * (DSN /p/<slug>, inbound) risolvono per progetto. La clipboard è lo stub di
 * userEvent.setup(): si legge il contenuto copiato con readText().
 */

const props = {
  ingestionKey: "abc123def456",
  slug: "demo-shop",
  projectName: "Demo Shop",
  origin: "https://track.example.com",
};

describe("IntegrationPanel", () => {
  it("mostra chiave, DSN con chiave@host/p/slug e snippet init()", () => {
    render(<IntegrationPanel {...props} />);

    expect(screen.getByText("abc123def456")).toBeInTheDocument();
    expect(
      screen.getByText("https://abc123def456@track.example.com/p/demo-shop"),
    ).toBeInTheDocument();
    const snippet = screen.getByTestId("init-snippet");
    expect(snippet.textContent).toContain('from "@stubwise/sdk/browser"');
    expect(snippet.textContent).toContain(
      'dsn: "https://abc123def456@track.example.com/p/demo-shop"',
    );
  });

  it("il bottone copia scrive la chiave negli appunti e conferma", async () => {
    const user = userEvent.setup();
    render(<IntegrationPanel {...props} />);

    await user.click(screen.getByRole("button", { name: "Copy ingestion key" }));

    expect(await navigator.clipboard.readText()).toBe("abc123def456");
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("copia DSN e snippet con i rispettivi bottoni", async () => {
    const user = userEvent.setup();
    render(<IntegrationPanel {...props} />);

    await user.click(screen.getByRole("button", { name: "Copy DSN" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://abc123def456@track.example.com/p/demo-shop",
    );

    await user.click(screen.getByRole("button", { name: "Copy snippet" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('import { init } from "@stubwise/sdk/browser"');
    expect(copied).toContain("https://abc123def456@track.example.com/p/demo-shop");
  });

  it("non mostra la sezione del webhook git (concern per-repository, altrove)", () => {
    render(<IntegrationPanel {...props} />);
    expect(screen.queryByTestId("webhook-config")).not.toBeInTheDocument();
  });

  it("mostra il webhook generico con URL inbound assoluto e payload d'esempio", () => {
    render(<IntegrationPanel {...props} />);

    const inbound = screen.getByTestId("inbound-webhook");
    expect(inbound).toBeInTheDocument();
    // URL: POST {origin}/api/inbound/{slug}/ticket — derivato dall'origin come il DSN.
    expect(
      screen.getByText("https://track.example.com/api/inbound/demo-shop/ticket"),
    ).toBeInTheDocument();
    // L'header di auth rimanda alla chiave già mostrata, senza ri-esporla.
    expect(inbound.textContent).toContain("X-Stubwise-Key");
    // Esempio di payload JSON con i campi accettati dall'endpoint.
    const payload = screen.getByTestId("inbound-payload");
    expect(payload.textContent).toContain('"title"');
    expect(payload.textContent).toContain('"type": "bug"');
    expect(payload.textContent).toContain('"priority": "medium"');
    expect(payload.textContent).toContain('"reporterEmail"');
  });

  it("copia la guida SDK con DSN, ingestion key e npm reali", async () => {
    const user = userEvent.setup();
    render(<IntegrationPanel {...props} />);

    await user.click(screen.getByRole("button", { name: "Copy SDK install guide" }));

    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('# Install Stubwise error tracking in "Demo Shop"');
    expect(copied).toContain("https://abc123def456@track.example.com/p/demo-shop");
    expect(copied).toContain("abc123def456");
    expect(copied).toContain("npm install @stubwise/sdk");
    expect(copied).toContain('import { init } from "@stubwise/sdk/browser"');
  });

  it("il bottone scarica genera un .md con filename derivato dallo slug", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    // L'anchor è rimosso subito dopo il click: leggiamo `download` dentro il mock.
    let downloadAttr: string | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloadAttr = this.download;
      });
    render(<IntegrationPanel {...props} />);

    await user.click(screen.getByRole("button", { name: "Download SDK install guide (.md)" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloadAttr).toBe("stubwise-sdk-demo-shop.md");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    clickSpy.mockRestore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
