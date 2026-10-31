import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WhoCanLink } from "../../../components/WhoCanLink";
import {
  useConfigureRepositoryWebhook,
  useSimulateNextWebhookSetup,
  type RepositoryView,
} from "../../../data/queries";
import { formatDate } from "../../../notifications/time";
import { useToast } from "../../../tasks-ui/Toast";
import { CHECK_MS, CrossGlyph, wait } from "../../admin/integrations/parts";
import { PrototypeBox } from "../../automations/shared";
import { Segmented } from "../../automations/builder/controls";
import { CheckGlyph, OpenCircleGlyph } from "../../preferences/glyphs";
import { secondaryButton } from "../../tasks/controls";
import { useSettingsWrite } from "../SettingsFrame";

// Il webhook git di un repository (shape project-repositories.md, «La pagina
// del repository» → WEBHOOK). Lo stato in parole, ovunque uguale: glifo e
// parola, mai il solo colore. «Webhook configured» compare solo con lo
// stato `configured` del livello dati: dopo un `failed` la riga ✕ e nessun
// toast di riuscita. Configurare non chiede riconferma (nessun segreto
// esce). Senza `repos.manage` il bottone resta, spento, con la sua frase e
// «Who?», e il riquadro «Prototype only» non c'è.

type WebhookStateName = RepositoryView["webhook"]["state"];

/** Lo stato del webhook in glifo e parola: l'elenco e la testata della pagina. */
export function WebhookState({ state }: { state: WebhookStateName }) {
  const { t } = useTranslation();
  return (
    <span
      data-webhook-state={state}
      className={`inline-flex shrink-0 items-center gap-1.5 text-sm ${
        state === "configured"
          ? "text-ink"
          : state === "failed"
            ? "text-critical"
            : "text-ink-muted"
      }`}
    >
      <WebhookGlyph state={state} />
      <span>{t(`settings.repos.states.${state}`)}</span>
    </span>
  );
}

function WebhookGlyph({ state }: { state: WebhookStateName }) {
  if (state === "configured")
    return (
      <span className="text-positive">
        <CheckGlyph size={14} />
      </span>
    );
  if (state === "failed") return <CrossGlyph />;
  return <OpenCircleGlyph size={12} />;
}

export function WebhookSection({
  repository,
  canManage,
  projectId,
  code,
  onReload,
}: {
  repository: RepositoryView;
  canManage: boolean;
  projectId: string;
  code: string;
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const configure = useConfigureRepositoryWebhook();
  const write = useSettingsWrite(code, onReload);
  const [configuring, setConfiguring] = useState(false);
  // L'esito scelto vale una volta (il livello dati lo azzera): dopo, il riquadro torna a «Configured».
  const [nextSetup, setNextSetup] = useState<"configured" | "failed">("configured");
  const simulate = useSimulateNextWebhookSetup();
  const pendingChoice = useRef<Promise<unknown>>(Promise.resolve());
  const headingId = useId();
  const whyId = useId();
  const { state, configuredAt } = repository.webhook;
  const date = configuredAt ? formatDate(configuredAt, i18n.language) : "";

  async function run() {
    if (!canManage || configuring) return;
    setConfiguring(true);
    await write.run(
      async () => {
        // L'esito scelto nel riquadro arriva al livello dati prima della configurazione.
        await pendingChoice.current;
        const [result] = await Promise.all([configure.mutateAsync(repository.id), wait(CHECK_MS)]);
        return result;
      },
      () => undefined,
      // In `onDone`, così il toast c'è anche dopo un Retry riuscito.
      // `failed`: la riga ✕ lo dice, nessun toast di riuscita.
      (result) => {
        if (result.ok && result.state === "configured")
          toast.show(
            t(result.updated ? "settings.repos.webhook.updated" : "settings.repos.webhook.done"),
          );
      },
    );
    setConfiguring(false);
    setNextSetup("configured");
  }

  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2 id={headingId} className="heading-group border-b border-rule pb-2">
        {t("settings.repos.webhook.title")}
      </h2>
      <div className="flex flex-col gap-3 pt-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <p
            className={`flex min-w-0 flex-1 basis-[36ch] items-start gap-1.5 text-md text-pretty ${
              state === "failed"
                ? "text-critical"
                : state === "configured"
                  ? "text-ink"
                  : "text-ink-muted"
            }`}
          >
            <span className="mt-[3px] shrink-0">
              <WebhookGlyph state={state} />
            </span>
            <span className="min-w-0 max-w-[72ch]">
              {t(`settings.repos.webhook.lines.${state}`, {
                date,
                account: repository.gitAccount?.name ?? t("settings.repos.webhook.accountFallback"),
              })}
            </span>
          </p>
          <span className="flex shrink-0 items-center gap-2">
            {!canManage && (
              <WhoCanLink action="manageRepos" projectId={projectId} projectCode={code} />
            )}
            <button
              type="button"
              aria-disabled={!canManage || configuring || undefined}
              aria-describedby={canManage ? undefined : whyId}
              title={canManage ? undefined : t("settings.repos.webhook.readOnly", { code })}
              onClick={() => void run()}
              className={`${secondaryButton} aria-disabled:cursor-not-allowed aria-disabled:opacity-40`}
            >
              {configuring
                ? t("settings.repos.webhook.configuring")
                : state === "configured"
                  ? t("settings.repos.webhook.again")
                  : t("settings.repos.webhook.configure")}
            </button>
          </span>
        </div>
        {!canManage && (
          <p id={whyId} className="text-xs text-ink-muted">
            {t("settings.repos.webhook.readOnly", { code })}
          </p>
        )}
        {write.message}
        <p className="text-xs text-ink-muted">
          {t("settings.repos.webhook.byHand")}{" "}
          <Link
            to="/p/$code/settings/$section"
            params={{ code, section: "integration" }}
            className="text-ink underline underline-offset-4"
          >
            {t("settings.repos.webhook.integration")}
          </Link>
          .
        </p>
        {canManage && (
          <NextSetupBox
            value={nextSetup}
            onChange={(o) => {
              setNextSetup(o);
              pendingChoice.current = simulate.mutateAsync(o).catch(() => undefined);
            }}
          />
        )}
      </div>
    </section>
  );
}

/** «Prototype only»: come finisce la prossima configurazione. Nessuna voce del registro. */
function NextSetupBox({
  value,
  onChange,
}: {
  value: "configured" | "failed";
  onChange: (outcome: "configured" | "failed") => void;
}) {
  const { t } = useTranslation();
  return (
    <PrototypeBox>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-ink-muted">
          {t("settings.repos.webhook.prototype.label")}
        </span>
        <Segmented<"configured" | "failed">
          label={t("settings.repos.webhook.prototype.label")}
          value={value}
          options={(["configured", "failed"] as const).map((o) => ({
            value: o,
            label: t(`settings.repos.webhook.prototype.${o}`),
          }))}
          onChange={onChange}
        />
      </div>
    </PrototypeBox>
  );
}
