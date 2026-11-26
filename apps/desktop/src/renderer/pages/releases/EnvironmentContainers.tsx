import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useServer, useSetEnvironmentContainers } from "../../data/queries";
import type { EnvironmentView } from "../../data/releases";
import { Dialog } from "../../tasks-ui/Dialog";
import { primaryButton, secondaryButton } from "../tasks/controls";

// I container di un ambiente su uno dei suoi server (area 8, F4b, R0-D, R7):
// dicono quale progetto possiede un container, e su di loro si reggono
// l'attribuzione di un guasto e il piano di correzione. Si scelgono fra
// quelli che l'agente riporta per quel server (i servizi docker del suo
// dettaglio): chi non vede il server non può elencarli, e il dialogo lo dice.

const ERRORS = new Set([
  "container_of_other_project",
  "unknown_container",
  "server_not_in_environment",
]);

/** I container dell'ambiente su `code`: l'unione delle sue righe con quel server. */
export function containersOn(environment: EnvironmentView, code: string): string[] {
  return [
    ...new Set(
      environment.servers.flatMap((s) => (s.serverCode === code ? (s.containers ?? []) : [])),
    ),
  ];
}

export function ContainersDialog({
  environment,
  code,
  onClose,
}: {
  environment: EnvironmentView;
  code: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const server = useServer(code);
  const save = useSetEnvironmentContainers();
  const [picked, setPicked] = useState<string[]>(() => containersOn(environment, code));
  const [error, setError] = useState<string | null>(null);
  const catalog = (server.data?.services ?? [])
    .filter((s) => s.source === "docker")
    .map((s) => s.name);
  const toggle = (name: string) => {
    setError(null);
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  };
  const params = { name: environment.name, code };

  return (
    <Dialog
      title={t("releases.environments.containers.title", params)}
      description={t("releases.environments.containers.body", params)}
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("servers.cancel")}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={!server.data || save.isPending}
            onClick={() =>
              save.mutate(
                // Nell'ordine del catalogo, come l'agente li riporta.
                {
                  id: environment.id,
                  serverCode: code,
                  containers: catalog.filter((c) => picked.includes(c)),
                },
                {
                  onSuccess: onClose,
                  onError: (e) => {
                    const what = e instanceof Error ? e.message.replace(/^invalid: /, "") : "";
                    setError(
                      t(
                        `releases.environments.containers.errors.${ERRORS.has(what) ? what : "generic"}`,
                        params,
                      ),
                    );
                  },
                },
              )
            }
          >
            {t("releases.environments.containers.save")}
          </button>
        </>
      }
    >
      {server.isPending ? (
        <p role="status" className="text-sm text-ink-muted">
          {t("releases.environments.containers.loading")}
        </p>
      ) : server.isError ? (
        <p className="text-sm text-pretty text-ink-muted">
          {t("releases.environments.containers.unseen", params)}
        </p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {t("releases.environments.containers.none", params)}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {catalog.map((name) => (
            <li key={name}>
              <label className="flex h-7 items-center gap-2 text-md text-ink">
                <input
                  type="checkbox"
                  name={name}
                  checked={picked.includes(name)}
                  onChange={() => toggle(name)}
                />
                <span className="num">{name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </Dialog>
  );
}
