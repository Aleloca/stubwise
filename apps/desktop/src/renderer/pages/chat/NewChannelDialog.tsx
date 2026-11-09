import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateChannel, usePeople, useProjects, useSessionPersonId } from "../../data/queries";
import type { ChannelView, Project } from "../../data/types";
import { can, useViewer } from "../../data/viewer";
import { Dialog, DialogField, inputClass, selectButtonClass } from "../../tasks-ui/Dialog";
import { MenuGroup, RadioItem } from "../../tasks-ui/Menu";
import { Chevron, MenuButton, primaryButton, secondaryButton } from "../tasks/controls";
import { PeoplePicker } from "./PeoplePicker";

// «New channel» (shape chat-manage.md §3): una decisione alla volta, con la
// conseguenza scritta sotto ogni scelta. Dove nasce (i soli progetti in cui
// si ha `chat.channels.create`, e «Company-wide» in testa con
// `chat.general.create`), il nome (minuscole, numeri, trattini: gli spazi
// diventano trattini mentre si scrive), la descrizione, aperto o privato e,
// per un privato, chi c'è da subito (in un progetto solo i suoi membri).

const NAME_MAX = 40;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Come la casella scrive il nome: minuscole, spazi in trattini, niente fuori dall'alfabeto del nome. */
export function typedChannelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, NAME_MAX);
}

/** I progetti in cui chi guarda può creare canali, per codice. */
function useCreatableProjects(): Project[] | undefined {
  const { viewer } = useViewer();
  return useProjects()
    .data?.filter((p) => can(viewer, "chat.channels.create", p.id))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** `null` = l'azienda (canale generale). */
type Scope = string | null;

export function NewChannelDialog({
  initialScope,
  onCreated,
  onClose,
}: {
  /** `"company"`, il codice di un progetto, o niente (il primo ambito possibile). */
  initialScope?: string | undefined;
  onCreated: (channel: ChannelView) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const me = useSessionPersonId();
  const projects = useCreatableProjects();
  const allProjects = useProjects().data;
  const people = usePeople().data;
  const create = useCreateChannel();
  const company = can(viewer, "chat.general.create");
  const nameId = useId();
  const descriptionId = useId();
  const nameHintId = useId();

  const fromCode = projects?.find((p) => p.code === initialScope);
  const defaultScope: Scope | undefined =
    initialScope === "company" && company
      ? null
      : fromCode
        ? fromCode.id
        : company
          ? null
          : projects?.[0]?.id;
  const [picked, setPicked] = useState<Scope | undefined>(undefined);
  const scope = picked === undefined ? defaultScope : picked;
  const project = scope ? allProjects?.find((p) => p.id === scope) : undefined;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<"open" | "private">("open");
  const [members, setMembers] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_RE.test(name);
  const preview = project ? `${project.code} · ${name}` : `# ${name}`;
  const candidates = (people ?? []).filter(
    (p) =>
      !p.isClaude && p.id !== me && (project === undefined || project.memberIds.includes(p.id)),
  );
  const nothing = projects !== undefined && projects.length === 0 && !company;

  const submit = () => {
    setTried(true);
    setError(null);
    if (scope === undefined || !nameValid) return;
    create.mutate(
      {
        projectId: scope,
        name,
        ...(description.trim() ? { description: description.trim() } : {}),
        visibility,
        ...(visibility === "private" ? { memberIds: members } : {}),
      },
      {
        onSuccess: onCreated,
        onError: (e) =>
          setError(
            e.message === "invalid: name_taken"
              ? project
                ? t("chat.newChannel.taken", { code: project.code })
                : t("chat.newChannel.takenCompany")
              : e.message === "invalid: name"
                ? t("chat.newChannel.nameRule")
                : t("chat.newChannel.failed"),
          ),
      },
    );
  };

  const nameError = tried && !nameValid ? t("chat.newChannel.nameRule") : null;

  return (
    <Dialog
      title={t("chat.newChannel.title")}
      onClose={onClose}
      width={480}
      confirmDiscard={
        name || description
          ? {
              message: t("chat.newChannel.discard"),
              keep: t("chat.newChannel.keep"),
              discard: t("chat.newChannel.discardAction"),
            }
          : undefined
      }
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("chat.newChannel.cancel")}
          </button>
          <button
            type="submit"
            form="new-channel"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={create.isPending || nothing}
          >
            {t("chat.newChannel.submit")}
          </button>
        </>
      }
    >
      <form
        id="new-channel"
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogField label={t("chat.newChannel.where")}>
          <MenuButton
            menuLabel={t("chat.newChannel.where")}
            ariaLabel={`${t("chat.newChannel.where")}: ${
              project ? `${project.code} ${project.name}` : t("chat.newChannel.company")
            }`}
            wrapperClassName="flex w-full min-w-0"
            disabled={nothing}
            className={selectButtonClass}
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
                    <span>{t("chat.newChannel.company")}</span>
                  )}
                </span>
                <Chevron />
              </>
            }
          >
            {(close) => (
              <MenuGroup>
                {company && (
                  <RadioItem
                    checked={scope === null}
                    onSelect={() => {
                      setPicked(null);
                      setMembers([]);
                      close();
                    }}
                  >
                    {t("chat.newChannel.company")}
                  </RadioItem>
                )}
                {projects?.map((p) => (
                  <RadioItem
                    key={p.id}
                    checked={scope === p.id}
                    onSelect={() => {
                      setPicked(p.id);
                      // Chi non è del nuovo progetto non può restare fra i membri.
                      setMembers((list) => list.filter((id) => p.memberIds.includes(id)));
                      close();
                    }}
                  >
                    <span className="num w-10 shrink-0 text-xs font-semibold text-ink-muted">
                      {p.code}
                    </span>
                    <span className="truncate">{p.name}</span>
                  </RadioItem>
                ))}
              </MenuGroup>
            )}
          </MenuButton>
        </DialogField>

        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium text-ink">
            {t("chat.newChannel.name")}
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameHintId}
            placeholder={t("chat.newChannel.namePlaceholder")}
            onChange={(e) => {
              setName(typedChannelName(e.target.value));
              setError(null);
            }}
            className={`${inputClass} ${nameError || error ? "border-critical" : ""}`}
          />
          <span id={nameHintId} className="text-xs">
            {nameError ? (
              <span className="text-critical">{nameError}</span>
            ) : name ? (
              <span className="text-ink-muted">
                {t("chat.newChannel.preview")}{" "}
                <span className="num font-semibold text-ink">{preview}</span>
              </span>
            ) : (
              <span className="text-ink-muted">{t("chat.newChannel.nameRule")}</span>
            )}
          </span>
        </div>

        <DialogField label={t("chat.newChannel.description")} htmlFor={descriptionId}>
          <input
            id={descriptionId}
            value={description}
            maxLength={200}
            placeholder={t("chat.newChannel.descriptionPlaceholder")}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </DialogField>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            {t("chat.newChannel.visibility")}
          </legend>
          {(["open", "private"] as const).map((v) => (
            <label
              key={v}
              className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 hover:bg-ink/4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
            >
              <input
                type="radio"
                name="visibility"
                value={v}
                checked={visibility === v}
                onChange={() => setVisibility(v)}
                className="mt-1 accent-[var(--ink)]"
              />
              <span className="flex flex-col">
                <span className="text-md font-medium text-ink">
                  {t(`chat.newChannel.${v}`)}
                </span>
                <span className="text-sm text-ink-muted">
                  {v === "open"
                    ? project
                      ? t("chat.newChannel.openProject", { code: project.code })
                      : t("chat.newChannel.openCompany")
                    : t("chat.newChannel.privateHint")}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {visibility === "private" && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-medium text-ink">
              {t("chat.newChannel.members")}
              {members.length > 0 && (
                <span className="num ml-1.5 text-ink-muted">{members.length}</span>
              )}
            </span>
            <PeoplePicker
              label={t("chat.newChannel.members")}
              candidates={candidates}
              selected={members}
              onToggle={(id) =>
                setMembers((list) =>
                  list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
                )
              }
            />
            <span className="text-xs text-ink-muted">
              {project
                ? t("chat.newChannel.onlyMembers", { code: project.code })
                : t("chat.newChannel.youAreIn")}
            </span>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
