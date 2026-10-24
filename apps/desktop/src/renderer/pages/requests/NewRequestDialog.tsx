import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateRequest, useCreateRequestFromMessage, useProjects } from "../../data/queries";
import type { Project, ProjectRequest } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";

/** I progetti a cui chi guarda può mandare richieste (`backlog.create`), per codice. */
function useRequestableProjects(): Project[] | undefined {
  const { viewer } = useViewer();
  const projects = useProjects().data;
  return projects
    ?.filter((p) => can(viewer, "backlog.create", p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * «New request»: titolo e dettagli, scritti per chi non ha mai aperto un
 * ticket («What do you need?», «Why it matters…»). Il progetto è quello
 * passato se chi guarda ci può mandare richieste; altrimenti (o fuori da un
 * progetto) si sceglie fra quelli con `backlog.create`. Il resto (simili,
 * fusioni, urgenza) lo decide il team dopo. `fromMessageId`: la richiesta
 * nasce da un messaggio della Chat, che la mostra («→ AUD-R14»).
 */
export function NewRequestDialog({
  projectId,
  fromMessageId,
  initial,
  onCreated,
  onClose,
}: {
  projectId?: string;
  /** Il messaggio della Chat da cui nasce («Create request»). */
  fromMessageId?: string;
  /** I valori di partenza (la proposta di Claude aperta con «Edit»). */
  initial?: { title?: string; description?: string };
  onCreated: (request: ProjectRequest, project: Project) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const projects = useRequestableProjects();
  const create = useCreateRequest();
  const fromMessage = useCreateRequestFromMessage();
  const titleId = useId();
  const descriptionId = useId();
  const allowed = projectId && can(viewer, "backlog.create", projectId) ? projectId : null;
  const [chosen, setChosen] = useState<string | null>(allowed);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tried, setTried] = useState(false);
  const [failed, setFailed] = useState(false);
  const project = projects?.find((p) => p.id === chosen);
  const noProjects = projects !== undefined && projects.length === 0;

  const submit = () => {
    setTried(true);
    if (!project || !title.trim()) return;
    setFailed(false);
    const input = { projectId: project.id, title: title.trim(), description: description.trim() };
    const callbacks = {
      onSuccess: (request: ProjectRequest) => onCreated(request, project),
      onError: () => setFailed(true),
    };
    if (fromMessageId) fromMessage.mutate({ messageId: fromMessageId, input }, callbacks);
    else create.mutate(input, callbacks);
  };

  return (
    <Dialog
      title={t("requests.newDialog.title")}
      description={t("requests.newDialog.description")}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("taskDetail.cancel")}
          </button>
          <button
            type="submit"
            form="new-request"
            className={primaryButton}
            disabled={create.isPending || noProjects}
          >
            {t("requests.newDialog.submit")}
          </button>
        </>
      }
    >
      <form
        id="new-request"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogField label={t("requests.newDialog.project")}>
          <MenuButton
            menuLabel={t("requests.newDialog.project")}
            ariaLabel={`${t("requests.newDialog.project")}: ${
              project
                ? `${project.code} ${project.name}`
                : noProjects
                  ? t("requests.newDialog.noProjects")
                  : t("requests.newDialog.chooseProject")
            }`}
            wrapperClassName="flex w-full min-w-0"
            disabled={noProjects}
            className={`${selectButtonClass} disabled:opacity-50 ${tried && !project && !noProjects ? "border-critical" : ""}`}
            label={
              <>
                <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                  {project ? (
                    <>
                      <span className="num shrink-0 text-xs font-semibold text-ink-muted">
                        {project.code}
                      </span>
                      <span className="truncate">{project.name}</span>
                    </>
                  ) : (
                    <span className="text-ink-faint">
                      {noProjects
                        ? t("requests.newDialog.noProjects")
                        : t("requests.newDialog.chooseProject")}
                    </span>
                  )}
                </span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup>
                {(projects ?? []).map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={p.id === chosen}
                    onSelect={() => {
                      close();
                      setChosen(p.id);
                    }}
                  >
                    <span className="num w-9 shrink-0 text-xs font-semibold text-ink-muted">
                      {p.code}
                    </span>
                    <span className="min-w-0 truncate">{p.name}</span>
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
          {tried && !project && !noProjects && (
            <span className="text-xs text-critical">{t("requests.newDialog.projectMissing")}</span>
          )}
        </DialogField>

        <DialogField label={t("requests.newDialog.fieldTitle")} htmlFor={titleId}>
          <input
            id={titleId}
            data-autofocus
            value={title}
            aria-invalid={tried && !title.trim()}
            placeholder={t("requests.newDialog.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
            className={`${inputClass} ${tried && !title.trim() ? "border-critical" : ""}`}
          />
          {tried && !title.trim() && (
            <span className="text-xs text-critical">{t("requests.newDialog.titleMissing")}</span>
          )}
        </DialogField>

        <DialogField
          label={t("requests.newDialog.fieldDescription")}
          htmlFor={descriptionId}
          hint={t("requests.newDialog.descriptionHint")}
        >
          <textarea
            id={descriptionId}
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputClass} resize-y`}
          />
        </DialogField>

        {failed && (
          <p role="alert" className="rounded-md bg-critical/10 px-3 py-2 text-sm text-ink">
            {t("requests.newDialog.failed")}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Montato dal layout su `?newRequest=<CODE>` o `?newRequest=1` (fuori da un
 * progetto: il progetto si sceglie nel dialogo), in ogni route. Mandata la
 * richiesta si va alle richieste del suo progetto con la nuova aperta nel
 * pannello: la riga dice già se somiglia a un'altra, e lo dice anche il
 * messaggio di conferma.
 */
export function NewRequestHost() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { newRequest?: string };
  const projects = useProjects().data;
  const value = search.newRequest;
  if (!value) return null;
  const code = value === "1" ? undefined : value;
  if (code && !projects) return null;
  const projectId = code ? projects?.find((p) => p.code === code)?.id : undefined;
  const close = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, newRequest: undefined }),
    } as never);
  return (
    <NewRequestDialog
      key={value}
      projectId={projectId}
      onClose={close}
      onCreated={(request, project) => {
        toast.show(
          request.similarToId
            ? t("requests.newDialog.sentSimilar", { project: project.name })
            : t("requests.newDialog.sent", { project: project.name }),
        );
        void navigate({
          to: "/p/$code/$section",
          params: { code: project.code, section: "requests" },
          search: { request: request.id } as never,
        });
      }}
    />
  );
}
