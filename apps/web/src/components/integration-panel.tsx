import { useTranslation } from "react-i18next";
import { downloadTextFile } from "../lib/install-guide-shared";
import { buildSdkInstallGuide, sdkGuideFilename } from "../lib/sdk-install-guide";
import { CopyButton } from "./copy-button";

interface IntegrationPanelProps {
  /** Chiave di ingestion del PROGETTO (Fase 3): condivisa da tutti i suoi repo. */
  ingestionKey: string;
  /**
   * Slug del PROGETTO: entra nel DSN (`…@host/p/<slug>`) e nell'URL del webhook
   * inbound. In Fase 3 l'ingestion è di progetto: gli endpoint risolvono per
   * slug di progetto, non più di repository.
   */
  slug: string;
  /** Nome del PROGETTO: solo per la guida di installazione dell'SDK. */
  projectName: string;
  /** Origin dell'istanza; di default quello della pagina corrente. */
  origin?: string;
}

/**
 * Sezione "Integrazione" di un PROGETTO: chiave di ingestion, DSN e snippet
 * `init()` pronto da incollare, più il webhook generico in ingresso, ognuno con
 * il suo bottone copia. In Fase 3 l'ingestion è di progetto (salita dal repo):
 * la chiave e gli endpoint valgono per tutti i repository del gruppo. Visibile
 * anche ai member: integrare l'SDK non richiede privilegi admin.
 */
export function IntegrationPanel({ ingestionKey, slug, projectName, origin }: IntegrationPanelProps) {
  const { t } = useTranslation();

  const resolvedOrigin = origin ?? window.location.origin;
  const url = new URL(resolvedOrigin);
  const dsn = `${url.protocol}//${ingestionKey}@${url.host}/p/${slug}`;
  // Webhook generico in ingresso: stesso schema URL del DSN (origin corrente),
  // crea un ticket a ogni chiamata. La chiave non si ri-espone qui: l'header
  // rimanda alla chiave di ingestion già mostrata sopra.
  const inboundUrl = `${url.protocol}//${url.host}/api/inbound/${slug}/ticket`;
  const inboundPayload = [
    "{",
    '  "title": "Checkout button unresponsive",',
    '  "body": "Steps to reproduce…",',
    '  "type": "bug",',
    '  "priority": "medium",',
    '  "reporterEmail": "user@example.com"',
    "}",
  ].join("\n");
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

      {/* Due colonne su schermi larghi (lg+): a sinistra SDK/ingest, a destra il
          webhook generico; sotto lg tornano impilate a colonna singola. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-4 lg:grid-cols-2">
        <div className="space-y-4">
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

          <SdkGuideActions
            ingestionKey={ingestionKey}
            slug={slug}
            projectName={projectName}
            origin={resolvedOrigin}
          />
        </div>

        <div
          className="space-y-4 border-t border-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
          data-testid="inbound-webhook"
        >
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("integration:inboundSection")}
            </span>
          </div>
          <IntegrationRow
            label={t("integration:inboundUrl")}
            copyLabel={t("integration:copyInboundUrl")}
            text={inboundUrl}
          />
          <div>
            <span className="mb-1.5 block font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("integration:inboundAuthLabel")}
            </span>
            <code className="block min-w-0 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal">
              {t("integration:inboundAuth")}
            </code>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                {t("integration:inboundPayload")}
              </span>
              <CopyButton text={inboundPayload} label={t("integration:copyInboundPayload")} />
            </div>
            <pre
              data-testid="inbound-payload"
              className="overflow-x-auto rounded-sm border border-line bg-ink-950/70 p-3 font-mono text-[12px] leading-relaxed text-fg"
            >
              <code>{inboundPayload}</code>
            </pre>
          </div>
          <p className="font-mono text-[11px] text-fg-faint">{t("integration:inboundHint")}</p>
        </div>
      </div>
    </section>
  );
}

/**
 * Azioni "guida di installazione SDK": copia negli appunti e scarica come `.md`
 * un documento autocontenuto (DSN, ingestion key, snippet browser/Node, verifica)
 * da incollare a un agent AI sul servizio di destinazione. La guida è generata al
 * click sull'origin corrente (funzione PURA `buildSdkInstallGuide`). Speculare a
 * `WidgetGuideActions`, ma per l'SDK di error tracking del progetto.
 */
function SdkGuideActions({
  ingestionKey,
  slug,
  projectName,
  origin,
}: {
  ingestionKey: string;
  slug: string;
  projectName: string;
  origin: string;
}) {
  const { t } = useTranslation();

  const buildGuide = (): string =>
    buildSdkInstallGuide({ projectSlug: slug, projectName, ingestionKey, origin });

  const handleDownload = (): void => {
    downloadTextFile(buildGuide(), sdkGuideFilename(slug));
  };

  return (
    <div className="flex items-center gap-2 border-t border-line pt-3">
      <span className="mr-auto font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
        {t("integration:guideSection")}
      </span>
      {/* CopyButton genera il testo una volta al render; è economico e i dati
          del progetto sono stabili. */}
      <CopyButton text={buildGuide()} label={t("integration:copyGuide")} />
      <button
        type="button"
        onClick={handleDownload}
        aria-label={t("integration:downloadGuide")}
        title={t("integration:downloadGuide")}
        className="tap shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-signal-dim hover:text-fg"
      >
        {t("integration:downloadGuideShort")}
      </button>
    </div>
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
