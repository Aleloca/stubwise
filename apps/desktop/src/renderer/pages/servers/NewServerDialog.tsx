import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateServer, useEnvironments } from "../../data/queries";
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
  const create = useCreateServer();
  const nameId = useId();
  const noteId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; agentKey: string } | null>(null);

  if (created) {
    return (
      <AgentKeyDialog
        title={t("servers.key.readyTitle", { code: created.code })}
        code={created.code}
        agentKey={created.agentKey}
        onDone={() => {
          onClose();
          void navigate({ to: "/admin/servers/$server", params: { server: created.code } });
        }}
      />
    );
  }

  const ready = name.trim().length > 0 && !create.isPending;
  const submit = () => {
    if (!ready) return;
    setError(null);
    create.mutate(
      { name, environmentId: null },
      {
        onSuccess: (r) => setCreated({ code: r.server.code, agentKey: r.agentKey }),
        onError: (e) => {
          const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
          setError(
            t(`servers.create.errors.${what}`, {
              defaultValue: t("servers.create.errors.generic"),
            }),
          );
        },
      },
    );
  };

  return (
    <Dialog
      title={t("admin.servers.create.title")}
      width={440}
      onClose={onClose}
      confirmDiscard={
        name.trim()
          ? {
              message: t("servers.create.discard"),
              keep: t("servers.create.keep"),
              discard: t("servers.create.discardConfirm"),
            }
          : undefined
      }
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
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function NewServerDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const envs = useEnvironments(project.id);
  const create = useCreateServer();
  const ids = { name: useId(), env: useId() };
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; agentKey: string } | null>(null);

  if (created) {
    return (
      <AgentKeyDialog
        title={t("servers.key.readyTitle", { code: created.code })}
        code={created.code}
        agentKey={created.agentKey}
        onDone={() => {
          onClose();
          void navigate({
            to: "/p/$code/servers/$server",
            params: { code: project.code, server: created.code },
          });
        }}
      />
    );
  }

  // Liberi: senza una riga per tutto il progetto (la stessa regola di `createServer`).
  const free = (envs.data?.environments ?? []).filter(
    (e) => !e.servers.some((s) => s.repositoryId === null),
  );
  const chosen = environmentId ?? free[0]?.id ?? "";
  const canEnvs = envs.data?.canManage ?? false;
  const ready = envs.data !== undefined;
  const form = ready && canEnvs && free.length > 0;

  const submit = () => {
    setError(null);
    create.mutate(
      { name, environmentId: chosen },
      {
        onSuccess: (r) => setCreated({ code: r.server.code, agentKey: r.agentKey }),
        onError: (e) => {
          const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
          setError(
            t(`servers.create.errors.${what}`, {
              defaultValue: t("servers.create.errors.generic"),
            }),
          );
        },
      },
    );
  };

  return (
    <Dialog
      title={t("servers.create.title", { code: project.code })}
      width={480}
      onClose={onClose}
      confirmDiscard={
        name.trim()
          ? {
              message: t("servers.create.discard"),
              keep: t("servers.create.keep"),
              discard: t("servers.create.discardConfirm"),
            }
          : undefined
      }
      footer={
        form ? (
          <>
            <button type="button" className={secondaryButton} onClick={onClose}>
              {t("servers.cancel")}
            </button>
            <button
              type="button"
              data-create-server
              disabled={create.isPending || !name.trim()}
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
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
