import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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
});
