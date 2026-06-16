import { useState } from "react";
import { useTranslation } from "react-i18next";
import { postConfigureWebhook } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { CopyButton } from "./copy-button";

interface IntegrationPanelProps {
  ingestionKey: string;
  slug: string;
  /** Origin dell'istanza; di default quello della pagina corrente. */
  origin?: string;
  /**
   * Config del webhook git (segreto HMAC + path), solo admin. Quando presente
   * si aggiunge la sezione "Webhook" con URL e segreto da configurare lato
   * provider. Assente per i member: il segreto non deve mai raggiungerli.
   */
  webhook?: { webhookSecret: string; webhookPath: string };
  /**
   * ISO dell'ultima configurazione automatica del webhook, o null se mai. Se
   * valorizzato l'azione di configurazione parte collassata in uno stato
   * "configurato il <data>", riapribile con "Riconfigura".
   */
  webhookConfiguredAt?: string | null;
  /** Notifica al genitore una (ri)configurazione riuscita, per riallineare lo stato. */
  onWebhookConfigured?: () => void;
}

type ConfigureState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

/**
 * Sezione "Integrazione" di un progetto: chiave di ingestion, DSN e snippet
 * `init()` pronto da incollare, ognuno con il suo bottone copia. Visibile
 * anche ai member: integrare l'SDK non richiede privilegi admin. La sezione
 * webhook compare solo se `webhook` è valorizzato (admin).
 */
export function IntegrationPanel({
  ingestionKey,
  slug,
  origin,
  webhook,
  webhookConfiguredAt,
  onWebhookConfigured,
}: IntegrationPanelProps) {
  const { t } = useTranslation();
  const [configure, setConfigure] = useState<ConfigureState>({ kind: "idle" });
  // Quando il webhook risulta già configurato l'azione parte collassata: il
  // bottone "Riconfigura" la riapre. Una (ri)configurazione riuscita la mostra
  // comunque (resta aperta per dare conferma all'utente).
  const [reconfiguring, setReconfiguring] = useState(false);
  const webhookConfigured = Boolean(webhookConfiguredAt);
  const showConfigureAction = !webhookConfigured || reconfiguring || configure.kind === "ok";

  async function onConfigure() {
    setConfigure({ kind: "pending" });
    try {
      const result = await postConfigureWebhook(slug);
      const message = result.updated
        ? t("integration:webhookUpdated", { url: result.url })
        : t("integration:webhookConfigured", { url: result.url });
      setConfigure({ kind: "ok", message });
      onWebhookConfigured?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("integration:configureFailed");
      setConfigure({ kind: "error", message });
    }
  }

  const url = new URL(origin ?? window.location.origin);
  const dsn = `${url.protocol}//${ingestionKey}@${url.host}/p/${slug}`;
  const webhookUrl = webhook ? `${url.protocol}//${url.host}${webhook.webhookPath}` : null;
  const snippet = [
    'import { init } from "@stubwise/sdk/browser";',
    "",
    "init({",
    `  dsn: "${dsn}",`,
    "});",
  ].join("\n");

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("integration:title")}
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          sdk · ingest
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <IntegrationRow
          label={t("integration:ingestionKey")}
          copyLabel={t("integration:copyIngestionKey")}
          text={ingestionKey}
        />
        <IntegrationRow label={t("integration:dsn")} copyLabel={t("integration:copyDsn")} text={dsn} />

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("integration:snippet")}
            </span>
            <CopyButton text={snippet} label={t("integration:copySnippet")} />
          </div>
          <pre
            data-testid="init-snippet"
            className="overflow-x-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg"
          >
            <code>{snippet}</code>
          </pre>
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            {t("integration:snippetHint")}
          </p>
        </div>

        {webhook && webhookUrl && (
          <div className="space-y-4 border-t border-line pt-4" data-testid="webhook-config">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                {t("integration:webhookSection")}
              </span>
            </div>
            <IntegrationRow
              label={t("integration:webhookUrl")}
              copyLabel={t("integration:copyWebhookUrl")}
              text={webhookUrl}
            />
            <IntegrationRow
              label={t("integration:webhookSecret")}
              copyLabel={t("integration:copyWebhookSecret")}
              text={webhook.webhookSecret}
            />
            <p className="font-mono text-[11px] text-fg-faint">
              {t("integration:webhookHint")}
            </p>
            <div className="space-y-2">
              {webhookConfigured && !showConfigureAction && (
                <div
                  data-testid="webhook-configured"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-ok/30 bg-ok/10 px-3 py-2.5"
                >
                  <span className="font-mono text-[12px] tracking-[0.04em] text-ok">
                    {t("integration:webhookConfiguredAt", {
                      date: formatDateTime(webhookConfiguredAt as string),
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setReconfiguring(true)}
                    data-testid="reconfigure-webhook-button"
                    className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
                  >
                    {t("integration:reconfigure")}
                  </button>
                </div>
              )}
              {showConfigureAction && (
              <button
                type="button"
                onClick={onConfigure}
                disabled={configure.kind === "pending"}
                data-testid="configure-webhook-button"
                className="rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-fg uppercase transition-colors hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
              >
                {configure.kind === "pending"
                  ? t("integration:configuring")
                  : t("integration:configureAuto")}
              </button>
              )}
              {configure.kind === "ok" && (
                <p data-testid="configure-webhook-ok" className="font-mono text-[11px] text-signal">
                  {configure.message}
                </p>
              )}
              {configure.kind === "error" && (
                <p
                  data-testid="configure-webhook-error"
                  className="font-mono text-[11px] text-danger"
                >
                  {configure.message}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function IntegrationRow({
  label,
  copyLabel,
  text,
}: {
  label: string;
  copyLabel: string;
  text: string;
}) {
  return (
    <div>
      <span className="mb-1.5 block font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
        {label}
      </span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal">
          {text}
        </code>
        <CopyButton text={text} label={copyLabel} />
      </div>
    </div>
  );
}
