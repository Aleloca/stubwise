import { useState } from "react";
import { postConfigureWebhook } from "../lib/api";
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
export function IntegrationPanel({ ingestionKey, slug, origin, webhook }: IntegrationPanelProps) {
  const [configure, setConfigure] = useState<ConfigureState>({ kind: "idle" });

  async function onConfigure() {
    setConfigure({ kind: "pending" });
    try {
      const result = await postConfigureWebhook(slug);
      const verb = result.updated ? "Webhook aggiornato" : "Webhook configurato";
      setConfigure({ kind: "ok", message: `${verb} su ${result.url}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Configurazione del webhook fallita";
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
          Integrazione
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          sdk · ingest
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <IntegrationRow label="Chiave di ingestion" copyLabel="Copia chiave di ingestion" text={ingestionKey} />
        <IntegrationRow label="DSN" copyLabel="Copia DSN" text={dsn} />

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              Snippet init()
            </span>
            <CopyButton text={snippet} label="Copia snippet" />
          </div>
          <pre
            data-testid="init-snippet"
            className="overflow-x-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg"
          >
            <code>{snippet}</code>
          </pre>
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            // variante browser — per Node: import da &quot;@stubwise/sdk/node&quot;
          </p>
        </div>

        {webhook && webhookUrl && (
          <div className="space-y-4 border-t border-line pt-4" data-testid="webhook-config">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                Webhook git · merge → done
              </span>
            </div>
            <IntegrationRow label="Webhook URL" copyLabel="Copia URL webhook" text={webhookUrl} />
            <IntegrationRow
              label="Webhook secret"
              copyLabel="Copia secret webhook"
              text={webhook.webhookSecret}
            />
            <p className="font-mono text-[11px] text-fg-faint">
              // configura questo URL e secret HMAC nel provider git: alla merge
              della PR il ticket passa a done
            </p>
            <div className="space-y-2">
              <button
                type="button"
                onClick={onConfigure}
                disabled={configure.kind === "pending"}
                data-testid="configure-webhook-button"
                className="rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-fg uppercase transition-colors hover:border-signal hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
              >
                {configure.kind === "pending" ? "Configurazione…" : "Configura automaticamente"}
              </button>
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
