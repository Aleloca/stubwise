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
  /** Se true, quando il progetto è fermo il poller propone voci dal backlog. */
  pulseEnabled: boolean;
  /** Cadenza minima fra due pulse dello stesso progetto, in giorni (1..30). */
  pulseEveryDays: number;
  /** Se true, una volta a settimana il worker scrive il brief del progetto. */
  weeklyBriefEnabled: boolean;
}

/** Estremi della cadenza del pulse: gli stessi del CHECK sul DB. */
const PULSE_DAYS_MIN = 1;
const PULSE_DAYS_MAX = 30;

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
  // Pulse proattivo: ping sul progetto fermo (default off).
  const [pulseEnabled, setPulseEnabled] = useState(initial.pulseEnabled);
  // Cadenza come STRINGA e non come numero: è il testo che l'utente sta
  // scrivendo, e un campo numerico controllato su uno `state` numerico non
  // saprebbe rappresentare il momento in cui il campo è vuoto (o a metà di
  // "15"). La conversione — e il range — si applicano all'invio.
  const [pulseEveryDays, setPulseEveryDays] = useState(String(initial.pulseEveryDays));
  const [weeklyBriefEnabled, setWeeklyBriefEnabled] = useState(initial.weeklyBriefEnabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Un pulse senza backlog non avrebbe nulla da proporre. Guarda lo STATO del
  // form e non `initial`: chi accende il backlog adesso deve poter accendere il
  // pulse nello stesso passaggio, senza salvare e rientrare.
  const pulseAvailable = backlogEnabled;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    // Il range 1..30 è il CHECK del DB (e lo schema del corpo): fermarsi qui
    // evita un 400 che direbbe la stessa cosa in inglese e senza contesto.
    // Sbagliato NON vuol dire "invariato": il valore si dice, non si scarta.
    //
    // Solo a controlli ATTIVI, però: col backlog spento il campo è disabilitato,
    // e un valore rimasto lì dentro bloccherebbe il salvataggio di tutto il
    // resto senza che lo si possa correggere.
    const days = Number(pulseEveryDays);
    const daysValid = Number.isInteger(days) && days >= PULSE_DAYS_MIN && days <= PULSE_DAYS_MAX;
    if (pulseAvailable && !daysValid) {
      setError(t("projects:form.pulseEveryDaysRange", { min: PULSE_DAYS_MIN, max: PULSE_DAYS_MAX }));
      return;
    }
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
        // Pulse: toggle e cadenza, ciascuno solo se cambiato.
        ...(pulseEnabled !== initial.pulseEnabled && { pulseEnabled }),
        // Solo se valida: coi controlli disabilitati può essere rimasta a metà,
        // e non si manda al server un valore che il CHECK rifiuterebbe.
        ...(daysValid && days !== initial.pulseEveryDays && { pulseEveryDays: days }),
        // Brief settimanale: incluso solo se cambiato, per un PATCH minimo.
        ...(weeklyBriefEnabled !== initial.weeklyBriefEnabled && { weeklyBriefEnabled }),
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

      {/*
        Pulse proattivo: toggle + cadenza (default off, 3 giorni). Vive DENTRO
        lo stesso riquadro della cadenza perché sono un'impostazione sola letta
        in una riga ("proponi ogni N giorni"), e si spegne insieme al backlog —
        senza voci da proporre il ping sarebbe muto.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-pulse"
            type="checkbox"
            checked={pulseEnabled}
            disabled={!pulseAvailable}
            onChange={(event) => setPulseEnabled(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal disabled:cursor-not-allowed disabled:opacity-50"
          />
          <label
            htmlFor="project-pulse"
            className={`font-mono text-[11px] font-medium tracking-[0.14em] uppercase ${
              pulseAvailable ? "text-fg-muted" : "text-fg-faint"
            }`}
          >
            {t("projects:form.pulse")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:form.pulseHint")}</p>

        <div className="mt-1 flex items-center gap-2.5">
          <label
            htmlFor="project-pulse-every-days"
            className={`font-mono text-[11px] font-medium tracking-[0.14em] uppercase ${
              pulseAvailable ? "text-fg-muted" : "text-fg-faint"
            }`}
          >
            {t("projects:form.pulseEveryDays")}
          </label>
          <input
            id="project-pulse-every-days"
            type="number"
            min={PULSE_DAYS_MIN}
            max={PULSE_DAYS_MAX}
            step={1}
            value={pulseEveryDays}
            disabled={!pulseAvailable}
            onChange={(event) => setPulseEveryDays(event.target.value)}
            className="w-20 rounded-sm border border-line-strong bg-ink-950/70 px-2 py-1 font-mono text-[13px] text-fg transition-colors hover:border-ink-700 focus-visible:border-signal-dim disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        {!pulseAvailable && (
          <p className="font-mono text-[11px] text-fg-faint">
            {t("projects:form.pulseNeedsBacklog")}
          </p>
        )}
      </div>

      {/*
        Brief settimanale: toggle (default off). A differenza del pulse NON
        dipende dal backlog e non ha nessun controllo disabilitato — il brief
        racconta quello che è già successo (report, ticket, PR, decisioni), e ha
        qualcosa da dire anche su un progetto senza backlog di discovery.
      */}
      <div className="flex flex-col gap-1.5 rounded-sm border border-line bg-ink-900 px-3 py-3">
        <div className="flex items-center gap-2.5">
          <input
            id="project-weekly-brief"
            type="checkbox"
            checked={weeklyBriefEnabled}
            onChange={(event) => setWeeklyBriefEnabled(event.target.checked)}
            className="h-4 w-4 shrink-0 accent-signal"
          />
          <label
            htmlFor="project-weekly-brief"
            className="font-mono text-[11px] font-medium tracking-[0.14em] text-fg-muted uppercase"
          >
            {t("projects:form.weeklyBrief")}
          </label>
        </div>
        <p className="font-mono text-[11px] text-fg-faint">{t("projects:form.weeklyBriefHint")}</p>
      </div>

      <FormError message={error} />
      <SubmitButton pending={pending}>
        {pending ? t("projects:form.saving") : t("projects:form.save")}
      </SubmitButton>
    </form>
  );
}
