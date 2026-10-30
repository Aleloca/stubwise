import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateServer, useEnvironments } from "../../data/queries";
import type { CreateServerInput } from "../../data/servers";
import type { Project } from "../../data/types";
import { Dialog, DialogField, inputClass } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { AgentKeyDialog } from "./AgentKeyPanel";
import { WhoCanLink } from "../../components/WhoCanLink";

// «New server» (shape servers.md [S 8]): un server nasce dentro un ambiente
// del progetto che non ha già un server per tutto il progetto (lo decide
// `createServer`: serve anche `environments.manage` lì). Senza ambienti
// liberi il dialogo rimanda a Releases → Environments. Creato, il dialogo
// diventa il pannello della chiave; chiuso quello si va al dettaglio.

type T = ReturnType<typeof useTranslation>["t"];

/** Un rifiuto di `createServer` in parole: la frase del campo, o quella generica. */
function createErrorMessage(e: unknown, t: T): string {
  const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
  return t(`servers.create.errors.${what}`, { defaultValue: t("servers.create.errors.generic") });
}

/** «Discard this server?» se il nome è già scritto; niente da chiedere se è vuoto. */
function createDiscard(name: string, t: T) {
  return name.trim()
    ? {
        message: t("servers.create.discard"),
        keep: t("servers.create.keep"),
        discard: t("servers.create.discardConfirm"),
      }
    : undefined;
}

/**
 * Il flusso di creazione, lo stesso dal progetto e dall'Amministrazione:
 * `submit` chiama `createServer`; un rifiuto diventa `error` (in parole);
 * creato, `keyPanel` è il pannello della chiave (vista una volta sola), e il
 * suo Done chiama `onDone` col codice del server nuovo.
 */
function useCreateServerFlow(onDone: (code: string) => void) {
  const { t } = useTranslation();
  const create = useCreateServer();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; agentKey: string } | null>(null);
  const submit = (input: CreateServerInput) => {
    setError(null);
    create.mutate(input, {
      onSuccess: (r) => setCreated({ code: r.server.code, agentKey: r.agentKey }),
      onError: (e) => setError(createErrorMessage(e, t)),
    });
  };
  const keyPanel = created ? (
    <AgentKeyDialog
      title={t("servers.key.readyTitle", { code: created.code })}
      code={created.code}
      agentKey={created.agentKey}
      onDone={() => onDone(created.code)}
    />
  ) : null;
  return { submit, error, pending: create.isPending, keyPanel };
}

/**
 * «New server» dall'Amministrazione (area 9b, shape admin-instance.md [IS 3],
 * confermata dal maintainer il 30 ott 2026): un server nasce SEMPRE senza
 * progetto — `createServer` con `environmentId: null` — e il dialogo non
 * offre ambienti: lo si collega dagli ambienti del progetto. Creato, il
 * pannello della chiave come dal progetto; chiuso, il dettaglio
 * dell'Amministrazione.
 */
export function NewInstanceServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const nameId = useId();
  const noteId = useId();
  const [name, setName] = useState("");
  const flow = useCreateServerFlow((code) => {
    onClose();
    void navigate({ to: "/admin/servers/$server", params: { server: code } });
  });

  if (flow.keyPanel) return flow.keyPanel;

  const ready = name.trim().length > 0 && !flow.pending;
  const submit = () => {
    if (ready) flow.submit({ name, environmentId: null });
  };

  return (
    <Dialog
      title={t("admin.servers.create.title")}
      width={440}
      onClose={onClose}
      confirmDiscard={createDiscard(name, t)}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            data-create-server
            disabled={!ready}
            onClick={submit}
            className={`${primaryButton} disabled:opacity-40`}
          >
            {t("servers.create.submit")}
          </button>
        </>
      }
    >
      <DialogField label={t("servers.create.name")} htmlFor={nameId}>
        <input
          id={nameId}
          data-autofocus
          maxLength={255}
          value={name}
          aria-describedby={noteId}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className={inputClass}
        />
      </DialogField>
      <p id={noteId} className="text-sm text-pretty text-ink-muted">
        {t("admin.servers.create.note")}
      </p>
      {flow.error && (
        <p role="alert" className="text-sm text-critical">
          {flow.error}
        </p>
      )}
    </Dialog>
  );
}

export function NewServerDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const envs = useEnvironments(project.id);
  const ids = { name: useId(), env: useId() };
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const flow = useCreateServerFlow((code) => {
    onClose();
    void navigate({
      to: "/p/$code/servers/$server",
      params: { code: project.code, server: code },
    });
  });

  if (flow.keyPanel) return flow.keyPanel;

  // Liberi: senza una riga per tutto il progetto (la stessa regola di `createServer`).
  const free = (envs.data?.environments ?? []).filter(
    (e) => !e.servers.some((s) => s.repositoryId === null),
  );
  const chosen = environmentId ?? free[0]?.id ?? "";
  const canEnvs = envs.data?.canManage ?? false;
  const ready = envs.data !== undefined;
  const form = ready && canEnvs && free.length > 0;

  const submit = () => flow.submit({ name, environmentId: chosen });

  return (
    <Dialog
      title={t("servers.create.title", { code: project.code })}
      width={480}
      onClose={onClose}
      confirmDiscard={createDiscard(name, t)}
      footer={
        form ? (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("servers.cancel")}
            </button>
            <button
              type="button"
              data-create-server
              disabled={flow.pending || !name.trim()}
              onClick={submit}
              className={`${primaryButton} disabled:opacity-40`}
            >
              {t("servers.create.submit")}
            </button>
          </>
        ) : (
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.close")}
          </button>
        )
      }
    >
      {!ready ? (
        <p role="status" className="text-sm text-ink-muted">
          {t("taskUi.states.loading")}
        </p>
      ) : !canEnvs ? (
        <p className="text-md text-ink">
          {t("servers.create.noEnvPermission", { code: project.code })}{" "}
          <WhoCanLink
            action="manageEnvironments"
            projectId={project.id}
            projectCode={project.code}
          />
        </p>
      ) : free.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-md text-ink">{t("servers.create.noFree", { code: project.code })}</p>
          <Link
            to="/p/$code/$section"
            params={{ code: project.code, section: "releases" }}
            hash="environments"
            onClick={onClose}
            className="rounded-sm text-sm text-ink underline underline-offset-4"
          >
            {t("servers.create.toEnvironments")}
          </Link>
        </div>
      ) : (
        <>
          <DialogField label={t("servers.create.name")} htmlFor={ids.name}>
            <input
              id={ids.name}
              data-autofocus
              maxLength={255}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) submit();
              }}
              className={inputClass}
            />
          </DialogField>
          <DialogField
            label={t("servers.create.environment")}
            htmlFor={ids.env}
            hint={t("servers.create.joins", { code: project.code })}
          >
            <select
              id={ids.env}
              value={chosen}
              onChange={(e) => setEnvironmentId(e.target.value)}
              className={`${inputClass} h-8`}
            >
              {free.map((e) => (
                <option key={e.id} value={e.id}>
                  {t("servers.create.envOption", {
                    name: e.name,
                    kind: t(`releases.environments.kinds.${e.kind}`),
                  })}
                </option>
              ))}
            </select>
          </DialogField>
          {flow.error && (
            <p role="alert" className="text-sm text-critical">
              {flow.error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
