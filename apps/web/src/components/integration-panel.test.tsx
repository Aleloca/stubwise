import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { IntegrationPanel } from "./integration-panel";

/**
 * Pannello di integrazione: chiave di ingestion, DSN derivata dall'origin e
 * snippet init() pronto da incollare, ciascuno con il proprio bottone copia.
 * La clipboard è lo stub installato da userEvent.setup(): si legge il
 * contenuto copiato con readText().
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

    await user.click(screen.getByRole("button", { name: "Copia chiave di ingestion" }));

    expect(await navigator.clipboard.readText()).toBe("abc123def456");
    expect(await screen.findByText("Copiato")).toBeInTheDocument();
  });

  it("copia DSN e snippet con i rispettivi bottoni", async () => {
    const user = userEvent.setup();
    render(<IntegrationPanel {...props} />);

    await user.click(screen.getByRole("button", { name: "Copia DSN" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://abc123def456@track.example.com/p/demo-shop",
    );

    await user.click(screen.getByRole("button", { name: "Copia snippet" }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('import { init } from "@stubwise/sdk/browser"');
    expect(copied).toContain("https://abc123def456@track.example.com/p/demo-shop");
  });

  it("senza prop webhook non mostra la sezione webhook (vista member)", () => {
    render(<IntegrationPanel {...props} />);
    expect(screen.queryByTestId("webhook-config")).not.toBeInTheDocument();
  });

  it("con webhook mostra URL assoluto e secret, copiabili (vista admin)", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationPanel
        {...props}
        webhook={{ webhookSecret: "s3cr3t-hmac", webhookPath: "/webhooks/git/demo-shop" }}
      />,
    );

    expect(screen.getByTestId("webhook-config")).toBeInTheDocument();
    expect(
      screen.getByText("https://track.example.com/webhooks/git/demo-shop"),
    ).toBeInTheDocument();
    expect(screen.getByText("s3cr3t-hmac")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copia secret webhook" }));
    expect(await navigator.clipboard.readText()).toBe("s3cr3t-hmac");
  });
});
