import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProjectIntegration, regenerateIngestionKey } from "../lib/api";
import { dropOneTimeSecret, peekOneTimeSecret } from "../lib/one-time-secrets";
import { IntegrationPanel } from "./integration-panel";

/**
 * Area 9, F5 (I2): l'Integrazione del progetto con la chiave d'ingestione
 * MASCHERATA. La chiave intera non esce da nessuna lettura: la si vede solo
 * alla creazione del progetto (decisione D) o subito dopo averla rigenerata (chi ha `project.settings.manage`, con la
 * riconferma), in questo componente e finché la pagina resta aperta.
 */
export function ProjectIntegrationSection({ projectId, slug, projectName }: { projectId: string; slug: string; projectName: string }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const queryKey = ["project-integration", projectId];
  const integration = useQuery({ queryKey, queryFn: () => getProjectIntegration(projectId) });
  // La chiave intera che la creazione del progetto ha appena dato (decisione
  // D), una volta; altrimenti solo dopo una rigenerazione.
  const createdKey = `ingestion-key:${projectId}`;
  const [revealed, setRevealed] = useState<string | null>(() => peekOneTimeSecret(createdKey));
  useEffect(() => {
    dropOneTimeSecret(createdKey);
  }, [createdKey]);
  const [confirming, setConfirming] = useState(false);
  const regenerate = useMutation({
    mutationFn: () => regenerateIngestionKey(projectId),
    onSuccess: (result) => {
      setRevealed(result.ingestionKey);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (!integration.data) return null;
  const { ingestion, canRegenerateKey } = integration.data;
  const date = ingestion.createdAt ? new Date(ingestion.createdAt).toLocaleDateString(i18n.language) : null;

  const footer = (
    <div className="space-y-2 font-mono text-[11px] text-fg-faint" data-testid="key-footer">
      {date && (
        <p>{ingestion.createdBy ? t("integration:keyCreated", { date, name: ingestion.createdBy.name }) : t("integration:keyCreatedAt", { date })}</p>
      )}
      {revealed && <p className="text-signal">{t("integration:keyRevealed")}</p>}
      {canRegenerateKey && !confirming && (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase hover:border-signal-dim hover:text-fg"
        >
          {t("integration:regenerateKey")}
        </button>
      )}
      {canRegenerateKey && confirming && (
        <div className="space-y-2">
          <p>{t("integration:regenerateKeyWarning")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
              className="tap rounded-sm border border-signal-dim px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg uppercase disabled:opacity-50"
            >
              {regenerate.isPending ? t("integration:regenerating") : t("integration:regenerateKeyConfirm")}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase"
            >
              {t("integration:regenerateKeyCancel")}
            </button>
          </div>
        </div>
      )}
      {regenerate.isError && <p role="alert">{t("integration:regenerateFailed")}</p>}
    </div>
  );

  return (
    <IntegrationPanel
      ingestionKey={revealed}
      last4={revealed ? revealed.slice(-4) : ingestion.last4}
      keyFooter={footer}
      canRegenerate={canRegenerateKey}
      slug={slug}
      projectName={projectName}
    />
  );
}
