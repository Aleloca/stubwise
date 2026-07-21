import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectPatch } from "../lib/api";
import { aiProvidersQueryOptions } from "../lib/queries";
import { FormError, SelectField, SubmitButton, TextField } from "./field";

interface ProjectInitialValues {
  name: string;
  /** Descrizione del progetto; null = assente. */
  description: string | null;
  /** Provider AI del progetto (Docs e fix); null = automatico (catena con failover). */
  aiProviderId: string | null;
  /** Se true, ogni push sul branch di default di un repo rigenera i suoi Docs. */
  docAutoUpdate: boolean;
  /** Se true, il worker genera ogni notte uno standup dai commit del giorno. */
  dailyReportEnabled: boolean;
  /** Se true, i ticket feedback/feature vengono deviati all'intake del backlog. */
  backlogEnabled: boolean;
}

interface ProjectFormProps {
  initial: ProjectInitialValues;
  onSubmit: (values: ProjectPatch) => Promise<void>;
}

/**
 * Form di impostazioni di un PROGETTO (gruppo): nome, descrizione e le
 * impostazioni di prodotto che valgono per TUTTI i repository del progetto — il
 * provider AI (Docs e fix) e l'auto-aggiornamento della documentazione ai push.
 *
 * Provider e auto-update vivevano prima sul form del repository: in Fase 1 sono
 * saliti qui, al progetto. La configurazione git (repoUrl, branch, account,
 * comandi) resta sul repository (vedi {@link RepositoryForm}).
 */
export function ProjectForm({ initial, onSubmit }: ProjectFormProps) {
  const { t } = useTranslation();
  // Provider AI configurati: alimentano il select del provider del progetto. Il
  // form è admin-only (montato solo per gli admin nel dettaglio progetto).
  const { data: providers } = useSuspenseQuery(aiProvidersQueryOptions);
  const sortedProviders = [...providers].sort((a, b) => a.position - b.position);

  const [name, setName] = useState(initial.name);
  // Descrizione come stringa controllata: vuoto = nessuna descrizione (null).
  const [description, setDescription] = useState(initial.description ?? "");
  // Provider AI: "" = automatico (catena con failover), id = provider scelto.
  const [aiProviderId, setAiProviderId] = useState(initial.aiProviderId ?? "");
  // Auto-aggiornamento Docs ai push (default off).
  const [docAutoUpdate, setDocAutoUpdate] = useState(initial.docAutoUpdate);
  // Report attività giornaliero: standup notturno dai commit del giorno (default off).
  const [dailyReportEnabled, setDailyReportEnabled] = useState(initial.dailyReportEnabled);
  // Backlog di discovery: deviazione dei ticket feedback/feature all'intake (default off).
  const [backlogEnabled, setBacklogEnabled] = useState(initial.backlogEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const trimmedDescription = description.trim();
      const nextDescription = trimmedDescription === "" ? null : trimmedDescription;
      // "" = automatico (catena con failover) → null lato server; altrimenti l'id scelto.
      const nextProviderId = aiProviderId === "" ? null : aiProviderId;
      await onSubmit({
        ...(name !== initial.name && { name }),
        // description inclusa solo se cambiata (null↔stringa) per un PATCH minimo.
        ...(nextDescription !== (initial.description ?? null) && { description: nextDescription }),
        // Provider incluso solo se cambiato (null↔id) per un PATCH minimo.
        ...(nextProviderId !== (initial.aiProviderId ?? null) && { aiProviderId: nextProviderId }),
        // docAutoUpdate incluso solo se cambiato (toggle), per un PATCH minimo.
        ...(docAutoUpdate !== initial.docAutoUpdate && { docAutoUpdate }),
        // dailyReportEnabled incluso solo se cambiato (toggle), per un PATCH minimo.
        ...(dailyReportEnabled !== initial.dailyReportEnabled && { dailyReportEnabled }),
        // backlogEnabled incluso solo se cambiato (toggle), per un PATCH minimo.
        ...(backlogEnabled !== initial.backlogEnabled && { backlogEnabled }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("common:unexpectedError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-4" noValidate>
      <TextField
        id="project-name"
        label={t("projects:form.name")}
        required
        placeholder={t("projects:form.namePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <TextField
        id="project-description"
        label={t("projects:form.description")}
        type="text"
        placeholder={t("projects:form.descriptionPlaceholder")}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />

      {/*
        Provider AI del progetto: vale per la generazione Docs e per i fix di
        tutti i suoi repository. "" = automatico (catena dei provider abilitati
        con failover).
      */}
      <SelectField
        id="project-ai-provider"
        label={t("projects:form.aiProvider")}
        value={aiProviderId}
        onChange={(event) => setAiProviderId(event.target.value)}
        options={[
          { value: "", label: t("projects:form.aiProviderAuto") },
          ...sortedProviders.map((provider) => ({
            value: provider.id,
            label: `${provider.label} (${provider.kind})`,
          })),
        ]}
      />
      <p className="-mt-1 font-mono text-[11px] text-fg-faint">{t("projects:form.aiProviderHint")}</p>

      {/*
        Auto-aggiornamento Docs: toggle (default off) ai push sul branch di
        default. Vale per tutti i repository del progetto.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-doc-auto-update"
            type="checkbox"
            checked={docAutoUpdate}
            onChange={(event) => setDocAutoUpdate(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="project-doc-auto-update"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("projects:form.docAutoUpdate")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:form.docAutoUpdateHint")}</p>
      </div>

      {/*
        Report attività giornaliero: toggle (default off). Se attivo, il worker
        genera ogni notte uno standup dai commit del giorno di tutti i repository
        del progetto.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-daily-report"
            type="checkbox"
            checked={dailyReportEnabled}
            onChange={(event) => setDailyReportEnabled(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="project-daily-report"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("projects:form.dailyReport")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:form.dailyReportHint")}</p>
      </div>

      {/*
        Backlog di discovery: toggle (default off). Se attivo, i ticket
        feedback/feature del progetto vengono deviati all'intake del backlog
        invece di entrare nella pipeline di fix.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-backlog"
            type="checkbox"
            checked={backlogEnabled}
            onChange={(event) => setBacklogEnabled(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="project-backlog"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("projects:form.backlog")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:form.backlogHint")}</p>
      </div>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("projects:form.saving") : t("projects:form.save")}
      </SubmitButton>
    </form>
  );
}
