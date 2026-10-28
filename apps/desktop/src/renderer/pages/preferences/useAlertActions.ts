import { useTranslation } from "react-i18next";
import type { ProjectSubscriptions, SubscriptionRow as Row, Undoable } from "../../data/alerts";
import { useMuteProjectAlerts, useSetAlertSubscription } from "../../data/queries";
import { useToast, type ToastAction } from "../../tasks-ui/Toast";

// Le azioni sulle iscrizioni che pagina, popover del progetto e pannello
// condividono: salvare un interruttore, spegnere tutto, «Undo». Un modulo di
// hook, così il layout non dipende da un file di pagina.

type ProjectRef = Pick<ProjectSubscriptions, "projectId" | "code">;

/**
 * «Undo» di una scrittura in blocco: se l'annullamento fallisce lo dice
 * (la cache si ricarica comunque), senza lasciare una promise rifiutata.
 */
export function useUndoAction() {
  const { t } = useTranslation();
  const toast = useToast();
  return (done: Undoable, code: string): ToastAction => ({
    label: t("alerts.undo"),
    run: () => {
      done.undo().catch(() => toast.error(t("alerts.undoError", { code })));
    },
  });
}

/** Scrive un interruttore; un errore lo riporta indietro (la cache) e lo dice, con «Retry». */
export function useSaveSwitch(project: ProjectRef) {
  const { t } = useTranslation();
  const set = useSetAlertSubscription();
  const toast = useToast();
  return function save(row: Row, change: { app?: boolean; phone?: boolean }) {
    const run = () =>
      set.mutate(
        { projectId: project.projectId, type: row.type, change },
        {
          onError: () =>
            toast.error(t("alerts.saveError", { label: t(row.labelKey), code: project.code }), {
              action: { label: t("alerts.retry"), run },
            }),
        },
      );
    run();
  };
}

/** «Spegni tutto» con «Annulla» nel toast (shape [A 11]): la usano il gruppo e il popover. */
export function useMuteProject() {
  const { t } = useTranslation();
  const mute = useMuteProjectAlerts();
  const toast = useToast();
  const undoAction = useUndoAction();
  return (p: ProjectRef) =>
    mute.mutateAsync(p.projectId).then(
      (done) =>
        toast.show(t("alerts.offDone", { code: p.code }), { action: undoAction(done, p.code) }),
      () => toast.error(t("alerts.bulkError", { code: p.code })),
    );
}
