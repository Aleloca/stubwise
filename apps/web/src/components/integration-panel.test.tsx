import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
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

  it("senza prop webhook non mostra la sezione webhook (vista member)", () => {
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

    await user.click(screen.getByRole("button", { name: "Copy webhook secret" }));
    expect(await navigator.clipboard.readText()).toBe("s3cr3t-hmac");
  });
});

describe("IntegrationPanel — configura webhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const webhookProps = {
    ...props,
    webhook: { webhookSecret: "s3cr3t-hmac", webhookPath: "/webhooks/git/demo-shop" },
  };

  it("click chiama postConfigureWebhook(slug) e mostra l'esito di successo", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "postConfigureWebhook").mockResolvedValue({
      ok: true,
      created: true,
      updated: false,
      detail: "Webhook configurato",
      url: "https://track.example.com/webhooks/git/demo-shop",
    });
    render(<IntegrationPanel {...webhookProps} />);

    await user.click(screen.getByTestId("configure-webhook-button"));

    expect(spy).toHaveBeenCalledWith("demo-shop");
    const ok = await screen.findByTestId("configure-webhook-ok");
    expect(ok.textContent).toMatch(/Webhook configured/);
    expect(ok.textContent).toContain("https://track.example.com/webhooks/git/demo-shop");
  });

  it("se il webhook esiste già mostra 'Webhook aggiornato'", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "postConfigureWebhook").mockResolvedValue({
      ok: true,
      created: false,
      updated: true,
      detail: "Webhook aggiornato",
      url: "https://track.example.com/webhooks/git/demo-shop",
    });
    render(<IntegrationPanel {...webhookProps} />);

    await user.click(screen.getByTestId("configure-webhook-button"));

    expect((await screen.findByTestId("configure-webhook-ok")).textContent).toMatch(
      /Webhook updated/,
    );
  });

  it("in errore mostra il messaggio (es. guida sullo scope)", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "postConfigureWebhook").mockRejectedValue(
      new Error("il token non ha lo scope webhook: rigeneralo"),
    );
    render(<IntegrationPanel {...webhookProps} />);

    await user.click(screen.getByTestId("configure-webhook-button"));

    expect((await screen.findByTestId("configure-webhook-error")).textContent).toMatch(
      /scope webhook/i,
    );
  });

  it("senza prop webhook il bottone configura non compare", () => {
    render(<IntegrationPanel {...props} />);
    expect(screen.queryByTestId("configure-webhook-button")).not.toBeInTheDocument();
  });

  it("webhookConfiguredAt null: mostra il bottone configura, non lo stato configurato", () => {
    render(<IntegrationPanel {...webhookProps} webhookConfiguredAt={null} />);
    expect(screen.getByTestId("configure-webhook-button")).toBeInTheDocument();
    expect(screen.queryByTestId("webhook-configured")).not.toBeInTheDocument();
  });

  it("webhookConfiguredAt valorizzato: stato compatto con data + 'Riconfigura', azione nascosta", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationPanel {...webhookProps} webhookConfiguredAt="2026-06-05T09:30:00.000Z" />,
    );

    expect(screen.getByTestId("webhook-configured")).toHaveTextContent("Webhook configured on");
    expect(screen.queryByTestId("configure-webhook-button")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reconfigure-webhook-button"));
    // "Riconfigura" rivela l'azione di configurazione automatica.
    expect(screen.getByTestId("configure-webhook-button")).toBeInTheDocument();
  });

  it("dopo una riconfigurazione riuscita notifica il genitore via onWebhookConfigured", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn();
    vi.spyOn(api, "postConfigureWebhook").mockResolvedValue({
      ok: true,
      created: false,
      updated: true,
      detail: "Webhook aggiornato",
      url: "https://track.example.com/webhooks/git/demo-shop",
    });
    render(
      <IntegrationPanel
        {...webhookProps}
        webhookConfiguredAt="2026-06-05T09:30:00.000Z"
        onWebhookConfigured={onConfigured}
      />,
    );

    await user.click(screen.getByTestId("reconfigure-webhook-button"));
    await user.click(screen.getByTestId("configure-webhook-button"));

    await screen.findByTestId("configure-webhook-ok");
    expect(onConfigured).toHaveBeenCalledTimes(1);
  });
});
