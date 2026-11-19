import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, postConfigureWebhook, regenerateWebhookSecret, type RepositoryWebhook } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { CopyButton } from "./copy-button";

interface WebhookConfigPanelProps {
  /** Slug del REPOSITORY: la config del webhook git è per-repository. */
  slug: string;
  /** Origin dell'istanza; di default quello della pagina corrente. */
  origin?: string;
  /**
   * Config del webhook git (path e ultime 4 del segreto HMAC), solo
   * `repos.manage`. Area 9, F5 (decisione C): il segreto intero non arriva da
   * qui; lo si vede una volta, alla creazione ({@link revealedSecret}) o
   * dopo averlo rigenerato da questo pannello.
   */
  webhook: RepositoryWebhook;
  /** Il segreto intero appena dato dalla creazione del repository, se c'è. */
  revealedSecret?: string | null;
  /** Notifica al genitore una rigenerazione riuscita, per rileggere la config. */
  onSecretRegenerated?: () => void;
  /**
   * ISO dell'ultima configurazione automatica del webhook, o null se mai. Se
   * valorizzato l'azione parte collassata in uno stato "configurato il <data>",
   * riapribile con "Riconfigura".
   */
  webhookConfiguredAt?: string | null;
  /** Notifica al genitore una (ri)configurazione riuscita, per riallineare lo stato. */
  onWebhookConfigured?: () => void;
}

type RegenState =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "pending" }
  | { kind: "done"; mode: "manual" | "platform" }
  | { kind: "error"; message: string };

type ConfigureState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

/**
 * Sezione "Webhook git" di un REPOSITORY (solo admin): URL e segreto HMAC del
 * webhook PR-merged, più la configurazione automatica lato provider. È una
 * concern per-repository (ogni repo ha il suo webhook): distinta dall'ingestion,
 * che in Fase 3 è salita al progetto (vedi IntegrationPanel).
 */
export function WebhookConfigPanel({
  slug,
  origin,
  webhook,
  webhookConfiguredAt,
  onWebhookConfigured,
  revealedSecret = null,
  onSecretRegenerated,
}: WebhookConfigPanelProps) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState<string | null>(revealedSecret);
  const [regen, setRegen] = useState<RegenState>({ kind: "idle" });
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

  async function onRegenerate() {
    setRegen({ kind: "pending" });
    try {
      const result = await regenerateWebhookSecret(slug);
      if (result.mode === "rollback" || !result.webhookSecret) {
        setRegen({ kind: "error", message: t("integration:secretRollback") });
        return;
      }
      setRevealed(result.webhookSecret);
      setRegen({ kind: "done", mode: result.mode === "platform" ? "platform" : "manual" });
      onSecretRegenerated?.();
    } catch (error) {
      const message =
        error instanceof ApiError && error.code === "webhook_scope_missing"
          ? t("integration:secretScopeMissing")
          : t("integration:regenerateSecretFailed");
      setRegen({ kind: "error", message });
    }
  }

  const url = new URL(origin ?? window.location.origin);
  const webhookUrl = `${url.protocol}//${url.host}${webhook.webhookPath}`;

  return (
    <section className="rounded-sm border border-line bg-ink-900" data-testid="webhook-config">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("integration:webhookSection")}
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          git · pr
        </span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <WebhookRow
          label={t("integration:webhookUrl")}
          copyLabel={t("integration:copyWebhookUrl")}
          text={webhookUrl}
        />
        {revealed ? (
          <WebhookRow
            label={t("integration:webhookSecret")}
            copyLabel={t("integration:copyWebhookSecret")}
            text={revealed}
          />
        ) : (
          <div>
            <span className="mb-1.5 block font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
              {t("integration:webhookSecret")}
            </span>
            <code
              data-testid="webhook-secret-masked"
              className="block rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-fg-muted"
            >
              {`••••••••${webhook.secretLast4 ?? ""}`}
            </code>
            <p className="mt-1.5 font-mono text-[11px] text-fg-faint">{t("integration:secretMaskedHint")}</p>
          </div>
        )}
        <div className="space-y-2" data-testid="webhook-secret-regenerate">
          {regen.kind === "done" && (
            <p className="font-mono text-[11px] text-signal">
              {regen.mode === "platform" ? t("integration:secretRevealedPlatform") : t("integration:secretRevealedManual")}
            </p>
          )}
          {regen.kind !== "confirming" && regen.kind !== "pending" && (
            <button
              type="button"
              onClick={() => setRegen({ kind: "confirming" })}
              data-testid="regenerate-secret-button"
              className="rounded-sm border border-line-strong bg-ink-950/70 px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase transition-colors hover:border-ink-700 hover:text-fg"
            >
              {t("integration:regenerateSecret")}
            </button>
          )}
          {(regen.kind === "confirming" || regen.kind === "pending") && (
            <div className="space-y-2">
              <p className="font-mono text-[11px] text-fg-faint">{t("integration:regenerateSecretWarning")}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={regen.kind === "pending"}
                  onClick={onRegenerate}
                  data-testid="regenerate-secret-confirm"
                  className="rounded-sm border border-signal-dim px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg uppercase disabled:opacity-50"
                >
                  {regen.kind === "pending" ? t("integration:regenerating") : t("integration:regenerateSecretConfirm")}
                </button>
                <button
                  type="button"
                  disabled={regen.kind === "pending"}
                  onClick={() => setRegen({ kind: "idle" })}
                  className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-fg-muted uppercase"
                >
                  {t("integration:regenerateKeyCancel")}
                </button>
              </div>
            </div>
          )}
          {regen.kind === "error" && (
            <p role="alert" data-testid="regenerate-secret-error" className="font-mono text-[11px] text-danger">
              {regen.message}
            </p>
          )}
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("integration:webhookHint")}</p>
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
            <p data-testid="configure-webhook-error" className="font-mono text-[11px] text-danger">
              {configure.message}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function WebhookRow({
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
