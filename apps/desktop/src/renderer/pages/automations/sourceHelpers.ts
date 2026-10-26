import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAutomations, useFetchAutomationRuns, useSimulateSourceEvent } from "../../data/queries";
import type { AutomationSourceView } from "../../data/types";
import { useToast } from "../../tasks-ui/Toast";
import { clientOf } from "./format";

// Gli aiuti delle sorgenti: chi le usa, gli eventi d'esempio in parole,
// l'apertura del pannello e «Simulate an event» col suo toast.

export type Automations = ReturnType<typeof useAutomations>["data"];

/** Le automazioni che partono da una sorgente (dalla versione pubblicata, o dall'ultima). */
export function usersOf(source: AutomationSourceView, automations: Automations) {
  return (automations ?? []).filter((a) => {
    const v = a.versions.filter((x) => x.publishedAt !== null).at(-1) ?? a.versions.at(-1)!;
    return v.flow.trigger.kind === "source" && v.flow.trigger.sourceId === source.id;
  });
}

/** Un evento d'esempio in parole: «Deal won · Cantina Bellavista Srl · CRM, Centralino AI». */
export function sampleWords(
  source: AutomationSourceView,
  e: Record<string, unknown>,
  t: (k: string, o?: Record<string, unknown>) => string,
) {
  const client = clientOf(e) ?? "";
  const deal = e.trattativa as { prodotti?: { nome?: string }[] } | undefined;
  const products = deal?.prodotti
    ?.map((p) => p.nome)
    .filter(Boolean)
    .join(", ");
  const request = (e.richiesta as { funzione?: string } | undefined)?.funzione;
  const kind =
    source.kind === "webhook"
      ? t("automations.sources.webhookEvent")
      : t("automations.sources.dealWon");
  return [kind, client, products ?? request].filter(Boolean).join(" · ");
}

export function useOpenSource() {
  const navigate = useNavigate();
  return (id: string | undefined) =>
    void navigate({
      to: "/automations/sources",
      search: ((prev: Record<string, unknown>) => ({ ...prev, source: id })) as never,
    });
}

/** «Simulate an event»: manda un evento d'esempio e dice quali esecuzioni sono partite. */
export function useSimulate(source: AutomationSourceView) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const simulate = useSimulateSourceEvent();
  const fetchRuns = useFetchAutomationRuns();
  const automations = useAutomations().data;
  const paused = usersOf(source, automations).find((a) => a.status === "paused");
  /** Un evento d'esempio (il suo indice) o scritto a mano (`{ payload }`, «Edit and send»). */
  return (sample: number | { payload: unknown }) =>
    simulate.mutate(
      typeof sample === "number"
        ? { sourceId: source.id, sampleIndex: sample }
        : { sourceId: source.id, payload: sample.payload },
      {
        onSuccess: async (ids) => {
          const runs = await fetchRuns(ids);
          if (runs.length === 0) {
            toast.show(
              paused
                ? `${t("automations.toast.eventNone")} · ${t("automations.toast.eventPaused", { code: paused.code })}`
                : t("automations.toast.eventNone"),
            );
          } else if (runs.length === 1) {
            const r = runs[0]!;
            toast.show(t("automations.toast.eventStarted", { code: r.code }), {
              action: {
                label: t("automations.actions.open"),
                run: () =>
                  void navigate({
                    to: "/automations/$code/runs/$n",
                    params: { code: r.automationCode, n: String(r.n) },
                  }),
              },
            });
          } else {
            toast.show(t("automations.toast.eventStartedMany", { count: runs.length }), {
              action: {
                label: t("automations.actions.show"),
                run: () => void navigate({ to: "/automations", search: { view: "runs" } as never }),
              },
            });
          }
        },
        // Un evento coi campi del tipo sbagliato non fa partire nulla (shape sources).
        onError: (e) =>
          toast.error(
            (e as Error).message === "invalid: event_types"
              ? t("automations.toast.eventTypes")
              : t("automations.toast.eventError"),
          ),
      },
    );
}
