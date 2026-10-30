import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeleteServer, useRegenerateAgentKey, useUpdateServer } from "../../data/queries";
import type { ServerDetail } from "../../data/servers";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { smallPrimary, smallSecondary } from "../task/parts";
import { dangerSolidButton, secondaryButton } from "../tasks/controls";
import { AgentKeyDialog } from "./AgentKeyPanel";
import { environmentsLine } from "./format";
import { Part, SavedNote, shortInput } from "./Part";

// Le impostazioni di un server (shape servers.md §3, «Settings»), solo per
// chi gestisce il monitoraggio: nome, ogni quanto riporta, progetto
// principale (fra le sole produzioni che lo usano), la chiave dell'agente
// (rigenerarla ferma l'agente finché non la si aggiorna) e la
// cancellazione, l'unico bottone `critical` della pagina.

function RegenerateDialog({ server, onClose }: { server: ServerDetail; onClose: () => void }) {
  const { t } = useTranslation();
  const regenerate = useRegenerateAgentKey();
  const [key, setKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (key) {
    return (
      <AgentKeyDialog
        title={t("servers.key.regeneratedTitle", { code: server.code })}
        code={server.code}
        agentKey={key}
        onDone={onClose}
      />
    );
  }
  return (
    <Dialog
      title={t("servers.settings.key.confirmTitle", { code: server.code })}
      description={t("servers.settings.key.confirmBody", { code: server.code })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose} data-autofocus>
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            disabled={regenerate.isPending}
            className={`${smallPrimary} h-8 px-3`}
            onClick={() =>
              regenerate.mutate(server.code, {
                onSuccess: (r) => setKey(r.agentKey),
                onError: () => setFailed(true),
              })
            }
          >
            {t("servers.settings.key.regenerate")}
          </button>
        </>
      }
    >
      {failed ? (
        <p role="alert" className="text-sm text-critical">
          {t("servers.settings.key.error")}
        </p>
      ) : null}
    </Dialog>
  );
}

function DeleteDialog({
  server,
  projectCode,
  onClose,
}: {
  server: ServerDetail;
  projectCode: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const remove = useDeleteServer();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const envs = environmentsLine(server, t);
  return (
    <Dialog
      title={t("servers.settings.delete.dialogTitle", { code: server.code })}
      width={460}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose} data-autofocus>
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            data-delete-server
            disabled={remove.isPending}
            className={dangerSolidButton}
            onClick={() =>
              remove.mutate(server.code, {
                onSuccess: () => {
                  onClose();
                  toast.show(t("servers.settings.delete.done", { code: server.code }));
                  // Torna all'elenco da cui si è aperto: il progetto o l'Amministrazione.
                  void (projectCode
                    ? navigate({
                        to: "/p/$code/$section",
                        params: { code: projectCode, section: "servers" },
                      })
                    : navigate({ to: "/admin/$section", params: { section: "servers" } }));
                },
                onError: (e) =>
                  setError(
                    t(
                      e instanceof Error && e.message === "invalid: busy"
                        ? "servers.settings.delete.busy"
                        : "servers.settings.delete.error",
                      { code: server.code },
                    ),
                  ),
              })
            }
          >
            {t("servers.settings.delete.confirm", { code: server.code })}
          </button>
        </>
      }
    >
      <p className="text-md text-ink">
        {envs
          ? t("servers.settings.delete.consequences", { code: server.code, envs })
          : t("servers.settings.delete.consequencesNone", { code: server.code })}
      </p>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function ServerSettings({
  server,
  projectCode,
}: {
  server: ServerDetail;
  projectCode: string | null;
}) {
  const { t } = useTranslation();
  const update = useUpdateServer();
  const ids = { name: useId(), interval: useId(), primary: useId() };
  const current = {
    name: server.name,
    interval: String(server.sampleIntervalSeconds),
    primary: server.productionProjects.some((p) => p.code === server.primaryProjectCode)
      ? (server.productionProjects.find((p) => p.code === server.primaryProjectCode)?.id ?? "")
      : (server.productionProjects[0]?.id ?? ""),
  };
  const [draft, setDraft] = useState(current);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"key" | "delete" | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const interval = Number(draft.interval);
  const intervalOk = Number.isInteger(interval) && interval >= 10 && interval <= 300;
  const edit = (patch: Partial<typeof draft>) => {
    setSaved(false);
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const submit = () =>
    update.mutate(
      {
        code: server.code,
        patch: {
          name: draft.name,
          sampleIntervalSeconds: interval,
          // Solo se cambiato: il valore di partenza può essere la ricaduta sulla
          // prima produzione (principale non impostato, o invisibile a chi guarda).
          ...(server.productionProjects.length > 1 &&
          draft.primary &&
          draft.primary !== current.primary
            ? { primaryProjectId: draft.primary }
            : {}),
        },
      },
      {
        onSuccess: () => setSaved(true),
        onError: (e) => {
          const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
          setError(
            t(`servers.settings.errors.${what}`, {
              defaultValue: t("servers.settings.errors.generic"),
            }),
          );
        },
      },
    );

  return (
    <Part id="settings" title={t("servers.index.settings")}>
      <form
        className="flex max-w-[560px] flex-col gap-4 border-t border-rule pt-4 pl-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && intervalOk && draft.name.trim()) submit();
        }}
      >
        <DialogField label={t("servers.settings.name")} htmlFor={ids.name}>
          <input
            id={ids.name}
            maxLength={255}
            value={draft.name}
            onChange={(e) => edit({ name: e.target.value })}
            className={inputClass}
          />
        </DialogField>
        <DialogField
          label={t("servers.settings.interval")}
          htmlFor={ids.interval}
          hint={t("servers.settings.intervalHint")}
        >
          <input
            id={ids.interval}
            type="number"
            min={10}
            max={300}
            value={draft.interval}
            aria-invalid={intervalOk ? undefined : true}
            onChange={(e) => edit({ interval: e.target.value })}
            className={`${shortInput} num h-8 w-32`}
          />
          {!intervalOk && (
            <span className="text-sm text-critical">
              {t("servers.settings.errors.sampleIntervalSeconds")}
            </span>
          )}
        </DialogField>
        <DialogField
          label={t("servers.settings.primary")}
          htmlFor={server.productionProjects.length > 1 ? ids.primary : undefined}
          hint={
            server.productionProjects.length > 0 ? t("servers.settings.primaryHint") : undefined
          }
        >
          {server.productionProjects.length > 1 ? (
            <select
              id={ids.primary}
              value={draft.primary}
              onChange={(e) => edit({ primary: e.target.value })}
              className={`${inputClass} h-8`}
            >
              {server.productionProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
          ) : server.productionProjects.length === 1 ? (
            <p className="text-md text-ink">
              {t("servers.settings.primaryOnly", { code: server.productionProjects[0]!.code })}
            </p>
          ) : server.analysisProject !== null ? (
            // Le produzioni ci sono, ma in progetti che chi guarda non vede (area 9b, R-G5).
            <p className="text-md text-ink-muted">{t("servers.settings.primaryHidden")}</p>
          ) : (
            <p className="text-md text-ink-muted">{t("servers.settings.primaryNone")}</p>
          )}
        </DialogField>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!dirty || !intervalOk || !draft.name.trim() || update.isPending}
            className={smallPrimary}
          >
            {t("servers.save")}
          </button>
          <SavedNote shown={saved && !dirty} />
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
        </div>
      </form>

      <div className="flex max-w-[560px] flex-col items-start gap-2 border-t border-rule pt-4 pl-3">
        <h3 className="text-md font-semibold text-ink">{t("servers.settings.key.title")}</h3>
        <p className="text-sm text-ink-muted">{t("servers.settings.key.body")}</p>
        <button type="button" className={smallSecondary} onClick={() => setDialog("key")}>
          {t("servers.settings.key.regenerate")}
        </button>
      </div>

      <div className="flex max-w-[560px] flex-col items-start gap-2 border-t border-rule pt-4 pl-3">
        <h3 className="text-md font-semibold text-ink">{t("servers.settings.delete.title")}</h3>
        <p className="text-sm text-ink-muted">
          {t("servers.settings.delete.body", { code: server.code })}
        </p>
        <button
          type="button"
          className="inline-flex h-7 items-center rounded-md border border-critical/50 px-2.5 text-sm font-semibold text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10"
          onClick={() => setDialog("delete")}
        >
          {t("servers.settings.delete.button", { code: server.code })}
        </button>
      </div>
      {dialog === "key" && <RegenerateDialog server={server} onClose={() => setDialog(null)} />}
      {dialog === "delete" && (
        <DeleteDialog server={server} projectCode={projectCode} onClose={() => setDialog(null)} />
      )}
    </Part>
  );
}
