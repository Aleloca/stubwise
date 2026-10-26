import { useTranslation } from "react-i18next";
import {
  useAutomations,
  useConnectAutomationSource,
  useDisconnectAutomationSource,
  usePeople,
  useSessionPersonId,
} from "../../data/queries";
import type { AutomationSourceView } from "../../data/types";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { PrototypeBox } from "./shared";
import { usersOf } from "./sourceHelpers";

// I dialoghi di una sorgente (shape automation-sources.md §6): collegare
// dichiara la simulazione ([A 4]); scollegare dice chi ne risente.

export function ConnectDialog({
  source,
  onClose,
}: {
  source: AutomationSourceView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const me = useSessionPersonId();
  const name = usePeople().data?.find((p) => p.id === me)?.name ?? "";
  const connect = useConnectAutomationSource();
  return (
    <Dialog
      title={t(
        source.status === "expired"
          ? "automations.sources.reconnectTitle"
          : "automations.sources.connectTitle",
        { name: source.name },
      )}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={connect.isPending}
            onClick={() =>
              connect.mutate(source.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.connected", { name: source.name }));
                },
                onError: () =>
                  toast.error(t("automations.toast.connectError", { name: source.name })),
              })
            }
          >
            {source.status === "expired"
              ? t("automations.sources.reconnect")
              : t("automations.sources.connect")}
          </button>
        </>
      }
    >
      <PrototypeBox>
        <p className="text-sm text-ink">{t("automations.sources.simulated")}</p>
      </PrototypeBox>
      <p className="text-md text-ink">
        {source.kind === "webhook"
          ? t("automations.sources.readsWebhook")
          : t("automations.sources.readsCrm", { name: source.name })}
      </p>
      <p className="text-sm text-ink-muted">{t("automations.sources.asYou", { name })}</p>
    </Dialog>
  );
}

export function DisconnectDialog({
  source,
  onClose,
}: {
  source: AutomationSourceView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const automations = useAutomations().data;
  const active = usersOf(source, automations).filter((a) => a.status === "active");
  const disconnect = useDisconnectAutomationSource();
  return (
    <Dialog
      title={t("automations.sources.disconnectTitle", { name: source.name })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={disconnect.isPending}
            onClick={() =>
              disconnect.mutate(source.id, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("automations.toast.disconnected", { name: source.name }));
                },
                onError: () =>
                  toast.error(t("automations.toast.connectError", { name: source.name })),
              })
            }
          >
            {t("automations.sources.disconnect")}
          </button>
        </>
      }
    >
      {active.length > 0 ? (
        <p data-affected className="text-md text-ink">
          {t("automations.sources.affects", {
            count: active.length,
            name: source.name,
            list: active.map((a) => `${a.code} ${a.name}`).join(", "),
          })}
        </p>
      ) : (
        <p className="text-md text-ink">
          {t("automations.sources.affectsNone", { name: source.name })}
        </p>
      )}
      <p className="text-sm text-ink-muted">
        {t("automations.sources.runsContinue")} {t("automations.sources.eventsLost")}
      </p>
    </Dialog>
  );
}
