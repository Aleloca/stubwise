import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { WebhookConfigPanel } from "./webhook-config-panel";

/**
 * Pannello del webhook git di un REPOSITORY (PR-merged): URL e segreto HMAC,
 * più la configurazione automatica lato provider. È una concern per-repository
 * (slug del repo), distinta dall'ingestion di progetto. La clipboard è lo stub
 * installato da userEvent.setup().
 */

const props = {
  slug: "demo-shop",
  origin: "https://track.example.com",
  webhook: { webhookSecret: "s3cr3t-hmac", webhookPath: "/webhooks/git/demo-shop" },
};

describe("WebhookConfigPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mostra URL assoluto e secret, copiabili", async () => {
    const user = userEvent.setup();
    render(<WebhookConfigPanel {...props} />);

    expect(screen.getByTestId("webhook-config")).toBeInTheDocument();
    expect(
      screen.getByText("https://track.example.com/webhooks/git/demo-shop"),
    ).toBeInTheDocument();
    expect(screen.getByText("s3cr3t-hmac")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy webhook secret" }));
    expect(await navigator.clipboard.readText()).toBe("s3cr3t-hmac");
  });

  it("click chiama postConfigureWebhook(slug) e mostra l'esito di successo", async () => {
    const user = userEvent.setup();
    const spy = vi.spyOn(api, "postConfigureWebhook").mockResolvedValue({
      ok: true,
      created: true,
      updated: false,
      detail: "Webhook configurato",
      url: "https://track.example.com/webhooks/git/demo-shop",
    });
    render(<WebhookConfigPanel {...props} />);

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
    render(<WebhookConfigPanel {...props} />);

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
    render(<WebhookConfigPanel {...props} />);

    await user.click(screen.getByTestId("configure-webhook-button"));

    expect((await screen.findByTestId("configure-webhook-error")).textContent).toMatch(
      /scope webhook/i,
    );
  });

  it("webhookConfiguredAt null: mostra il bottone configura, non lo stato configurato", () => {
    render(<WebhookConfigPanel {...props} webhookConfiguredAt={null} />);
    expect(screen.getByTestId("configure-webhook-button")).toBeInTheDocument();
    expect(screen.queryByTestId("webhook-configured")).not.toBeInTheDocument();
  });

  it("webhookConfiguredAt valorizzato: stato compatto con data + 'Riconfigura', azione nascosta", async () => {
    const user = userEvent.setup();
    render(<WebhookConfigPanel {...props} webhookConfiguredAt="2026-06-05T09:30:00.000Z" />);

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
      <WebhookConfigPanel
        {...props}
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
