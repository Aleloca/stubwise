import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useAutomations,
  useConnectAutomationSource,
  useCreateWebhookSource,
  useDisconnectAutomationSource,
  usePeople,
  useRenameSource,
  useSessionPersonId,
} from "../../data/queries";
import type { AutomationSourceView } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
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

/**
 * «Connect → Incoming webhook» (shape sources §«Webhook in arrivo»): il nome,
 * poi nasce l'indirizzo e si apre il pannello sul webhook nuovo, con «Paste
 * an example» in evidenza.
 */
export function NewWebhookDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const create = useCreateWebhookSource();
  const [name, setName] = useState("");
  const nameId = useId();
  const submit = () => {
    if (!name.trim()) return;
    create.mutate(name.trim(), {
      onSuccess: (source) => {
        onClose();
        toast.show(t("automations.toast.webhookCreated", { name: source.name }));
        onCreated(source.id);
      },
      onError: () => toast.error(t("automations.toast.webhookError")),
    });
  };
  return (
    <Dialog
      title={t("automations.sources.newWebhookTitle")}
      description={t("automations.sources.newWebhookBody")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("automations.actions.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!name.trim() || create.isPending}
            onClick={submit}
          >
            {t("automations.sources.create")}
          </button>
        </>
      }
    >
      <DialogField label={t("automations.sources.webhookName")} htmlFor={nameId}>
        <input
          id={nameId}
          data-autofocus
          className={inputClass}
          value={name}
          maxLength={80}
          placeholder={t("automations.sources.webhookNamePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </DialogField>
    </Dialog>
  );
}

/** «Rename» nel pannello: il nome in posto, Invio salva, Esc annulla. */
export function RenameSourceForm({
  source,
  onDone,
}: {
  source: AutomationSourceView;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const rename = useRenameSource();
  const [name, setName] = useState(source.name);
  const save = () => {
    if (!name.trim() || name.trim() === source.name) return onDone();
    rename.mutate(
      { id: source.id, name: name.trim() },
      {
        onSuccess: () => {
          onDone();
          toast.show(t("automations.toast.renamed", { name: name.trim() }));
        },
        onError: () => toast.error(t("automations.toast.connectError", { name: source.name })),
      },
    );
  };
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        aria-label={t("automations.sources.nameLabel")}
        className={inputClass}
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          }
        }}
      />
      <button type="button" className={primaryButton} disabled={rename.isPending} onClick={save}>
        {t("automations.sources.save")}
      </button>
    </div>
  );
}
