import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useNextPluginOutcome,
  usePlugins,
  useSimulateNextPluginOutcome,
  type PluginView,
} from "../../../data/queries";
import { formatDate } from "../../../notifications/time";
import { PrototypeBox } from "../../automations/shared";
import { Segmented } from "../../automations/builder/controls";
import { CheckGlyph } from "../../preferences/glyphs";
import { ReadError } from "../../preferences/parts";
import { primaryButton } from "../../tasks/controls";
import { AiSkeleton } from "../ai/parts";
import { CrossGlyph, Dot, IntegrationPage } from "./parts";
import { RegisterPluginDialog } from "./RegisterPluginDialog";

// Plugins (shape admin-integrations.md «Plugins»): il registro dei plugin di
// Claude Code, uno per riga, con lo stato e lo smoke test in parole, il ref e
// il commit, l'inventario contato. La riga intera apre la pagina del plugin.
// Si vede e si scrive con `plugins.manage`. Le transizioni (preparazione,
// smoke test) non passano da una chiamata: finché un plugin ha un passo in
// corso l'elenco si rilegge da solo (`usePlugins`), le righe hanno altezza
// fissa e il passaggio a «Ready» si annuncia.

export function PluginsPage() {
  const { t } = useTranslation();
  const plugins = usePlugins();
  const [registering, setRegistering] = useState(false);
  const announcement = useReadyAnnouncement(plugins.data);

  const action = (
    <button type="button" onClick={() => setRegistering(true)} className={primaryButton}>
      {t("admin.plugins.register")}
    </button>
  );

  return (
    <IntegrationPage title={t("admin.plugins.title")} intro={t("admin.plugins.intro")} action={action}>
      <p className="mt-2 text-xs text-ink-muted">{t("admin.plugins.base")}</p>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {plugins.isPending ? (
        <AiSkeleton rows={2} height={60} />
      ) : plugins.isError ? (
        <ReadError message={t("admin.plugins.loadError")} onRetry={() => void plugins.refetch()} />
      ) : plugins.data.length === 0 ? (
        <div className="mt-6 border-t border-rule pt-5">
          <p className="text-md text-ink">{t("admin.plugins.empty")}</p>
        </div>
      ) : (
        <ul aria-label={t("admin.plugins.list")} className="mt-6 border-t border-rule">
          {plugins.data.map((p) => (
            <PluginRow key={p.id} plugin={p} />
          ))}
        </ul>
      )}
      {!plugins.isPending && !plugins.isError && <NextOutcomeBox />}
      {registering && <RegisterPluginDialog onClose={() => setRegistering(false)} />}
    </IntegrationPage>
  );
}

/**
 * «superpowers is ready.» quando un plugin passa da in preparazione a pronto
 * (o «couldn't be prepared» a non riuscito), per `aria-live`: si confronta
 * con la lettura di prima, la persona può non guardare la riga.
 */
export function useReadyAnnouncement(plugins: PluginView[] | undefined): string {
  const { t } = useTranslation();
  const before = useRef<Map<string, PluginView["status"]>>(new Map());
  const [words, setWords] = useState("");
  useEffect(() => {
    if (!plugins) return;
    for (const p of plugins) {
      const was = before.current.get(p.id);
      if (was === "materializing" && p.status === "ready")
        setWords(t("admin.plugins.isReady", { name: p.name }));
      if (was === "materializing" && p.status === "failed")
        setWords(t("admin.plugins.isFailed", { name: p.name }));
    }
    before.current = new Map(plugins.map((p) => [p.id, p.status]));
  }, [plugins, t]);
  return words;
}

/** Lo stato con glifo e parola: «◌ Materializing…», «✓ Ready», «✕ Failed» (`critical`). */
export function PluginStatusWords({ status }: { status: PluginView["status"] }) {
  const { t } = useTranslation();
  const words = t(`admin.plugins.status.${status}`);
  if (status === "failed")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-critical">
        <CrossGlyph />
        <span>{words}</span>
      </span>
    );
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 text-sm ${status === "ready" ? "font-medium text-ink" : "text-ink-muted"}`}
    >
      {status === "ready" ? <CheckGlyph size={12} /> : <DottedCircleGlyph />}
      <span>{words}</span>
    </span>
  );
}

/** Lo smoke test in parole; niente se non è mai partito. */
export function SmokeWords({ smoke }: { smoke: PluginView["smoke"] }) {
  const { t } = useTranslation();
  if (!smoke) return null;
  const words = t(`admin.plugins.smoke.${smoke}`);
  if (smoke === "failed")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-sm text-critical">
        <CrossGlyph />
        <span>{words}</span>
      </span>
    );
  return (
    <span className={`shrink-0 text-sm ${smoke === "passed" ? "text-ink" : "text-ink-muted"}`}>
      {words}
    </span>
  );
}

/** Lo sha in 7 cifre tabellari. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/**
 * Un plugin (60 px fissi: lo stato cambia sul posto senza far saltare
 * l'elenco). Prima riga: nome (e lo slug se diverso) · stato, a destra lo
 * smoke test. Seconda: ref e pin, l'inventario contato (o la prima riga
 * dell'errore), chi l'ha aggiornato e quando.
 */
function PluginRow({ plugin: p }: { plugin: PluginView }) {
  const { t, i18n } = useTranslation();
  const nameId = useId();
  const firstErrorLine = p.error?.split("\n")[0] ?? null;
  return (
    <li aria-labelledby={nameId} className="border-b border-rule">
      <Link
        to="/admin/plugins/$pluginId"
        params={{ pluginId: p.id }}
        className="flex h-[60px] flex-col justify-center gap-1 rounded-sm px-1 transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span id={nameId} title={p.name} className="min-w-0 truncate text-md font-semibold text-ink">
              {p.name}
            </span>
            {p.slug !== p.name && <span className="shrink-0 text-xs text-ink-muted">{p.slug}</span>}
            <PluginStatusWords status={p.status} />
          </span>
          <SmokeWords smoke={p.smoke} />
        </span>
        <span className="flex min-w-0 items-center gap-x-1.5 overflow-hidden text-sm whitespace-nowrap text-ink-muted">
          <span className="shrink-0">{t("admin.plugins.ref", { ref: p.ref })}</span>
          {p.sha && (
            <>
              <Dot />
              <span className="num shrink-0">{t("admin.plugins.pin", { sha: shortSha(p.sha) })}</span>
            </>
          )}
          {p.status === "failed" && firstErrorLine ? (
            <>
              <Dot />
              <span title={p.error ?? undefined} className="min-w-0 truncate text-critical">
                {firstErrorLine}
              </span>
            </>
          ) : (
            <>
              {p.inventory && (
                <>
                  <Dot />
                  <span className="num shrink-0">
                    {`${t("admin.plugins.skills", { count: p.inventory.skills.length })} · ${t("admin.plugins.hooks", { count: p.inventory.hooks.length })}`}
                  </span>
                </>
              )}
              <Dot />
              <span className="min-w-0 truncate">
                {p.registeredByName
                  ? t("admin.plugins.updated", {
                      date: formatDate(p.updatedAt, i18n.language),
                      name: p.registeredByName,
                    })
                  : t("admin.plugins.updatedNoName", { date: formatDate(p.updatedAt, i18n.language) })}
              </span>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * Il riquadro «Prototype only»: come finisce la prossima registrazione o il
 * prossimo aggiornamento. L'esito lo rilegge dal livello dati, che lo
 * riporta a «Ready» dopo averlo usato.
 */
export function NextOutcomeBox() {
  const { t } = useTranslation();
  const next = useNextPluginOutcome();
  const simulate = useSimulateNextPluginOutcome();
  return (
    <div className="mt-8">
      <PrototypeBox label={t("admin.integrations.prototype.label")}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-ink">{t("admin.plugins.prototype.outcome")}</span>
          <Segmented<"ready" | "failed">
            label={t("admin.plugins.prototype.outcome")}
            value={next.data ?? "ready"}
            options={(["ready", "failed"] as const).map((o) => ({
              value: o,
              label: t(`admin.plugins.prototype.${o}`),
            }))}
            onChange={(o) => simulate.mutate(o)}
          />
        </div>
      </PrototypeBox>
    </div>
  );
}

/** «◌»: il cerchio tratteggiato di ciò che si sta preparando. */
function DottedCircleGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeDasharray="2.2 2.2"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}
