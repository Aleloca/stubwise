import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CHAT_EVENT_KINDS } from "../../data/chat";
import {
  useArchiveChannel,
  useChannelMembers,
  useChatChannel,
  useDeleteChannel,
  useDepartments,
  useInviteMembers,
  useJoinChannel,
  useLeaveChannel,
  usePeople,
  useProjects,
  useRemoveMember,
  useSessionPersonId,
  useSetNotifyLevel,
  useSetPublishedEvents,
  useUpdateChannel,
} from "../../data/queries";
import type { ChannelView, ChatEventKind, NotifyLevel, Person } from "../../data/types";
import {
  DOCKED_PANEL_QUERY,
  DetailPanel,
  forcesOverlay,
  type DetailPanelMode,
} from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { CheckBox } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { formatDate } from "../../notifications/time";
import { primaryButton, secondaryButton } from "../tasks/controls";
import {
  CloseIcon,
  Section,
  ghostButton,
  smallPrimary,
  smallSecondary,
} from "../task/parts";
import { channelIdOf } from "./ChatColumn";
import { useChannelName } from "./ChannelView";
import { ChatAvatar } from "./MessageItem";
import { PeoplePicker } from "./PeoplePicker";

// Le impostazioni del canale (shape chat-manage.md §3): un pannello di 400px
// nello stesso posto del thread (`?settings=1`, esclusivo con `?thread=`),
// a sezioni come il dettaglio della task — ABOUT (nome, descrizione,
// argomento sul posto), NOTIFICATIONS (personale), PUBLISHED EVENTS (canali
// di progetto), MEMBERS, e in fondo Leave / Archive / Delete. Ogni comando
// c'è solo se il livello dati lo permette (`ChannelView`); i campi che non si
// possono cambiare sono testo, con la riga che dice chi può.

const SETTINGS_WIDTH = 400;

/** La regola del nome di un canale, la stessa del livello dati. */
const CHANNEL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Un'azione distruttiva prima del suo dialogo: testo critico, mai pieno. */
const dangerText =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10 active:bg-critical/15";

/** Montato dal layout accanto al thread: si apre su `?settings=1` in un canale. */
export function ChannelSettingsHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { settings?: string; thread?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const channelId = channelIdOf(pathname);
  const personId = useSessionPersonId();
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const overlayOnly = forcesOverlay(pathname);
  const mode: DetailPanelMode = wide && !overlayOnly ? "docked" : "overlay";
  const close = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, settings: undefined }),
    } as never);
  if (search.settings !== "1" || !channelId || search.thread) return null;
  return (
    <>
      {mode === "overlay" && (
        <div
          aria-hidden="true"
          className="palette-backdrop fixed inset-0 z-30 bg-[var(--scrim)]"
          onClick={close}
        />
      )}
      <DetailPanel
        mode={mode}
        label={t("chat.settings.title")}
        onClose={close}
        defaultWidth={SETTINGS_WIDTH}
        modal
      >
        <ChannelSettings key={`${personId}:${channelId}`} channelId={channelId} onClose={close} />
      </DetailPanel>
    </>
  );
}

function ChannelSettings({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const channel = useChatChannel(channelId);
  if (channel.isPending) {
    return (
      <PanelHeader title={t("chat.settings.title")} onClose={onClose}>
        <span role="status" className="sr-only">
          {t("chat.settings.loading")}
        </span>
      </PanelHeader>
    );
  }
  if (!channel.data) {
    return (
      <>
        <PanelHeader title={t("chat.settings.title")} onClose={onClose} />
        <p className="px-4 py-4 text-md text-ink-muted">{t("chat.channel.notFound")}</p>
      </>
    );
  }
  return <SettingsBody channel={channel.data} onClose={onClose} />;
}

function PanelHeader({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <header className="page-header box-content flex h-12 shrink-0 items-center gap-2 border-b border-rule pl-4 [--page-header-pr:8px]">
      <h2 className="min-w-0 truncate text-lg font-semibold text-ink" title={title}>
        {title}
      </h2>
      {children}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.settings.close")}
        title={t("chat.settings.close")}
        className={`${ghostButton} ml-auto w-8 justify-center px-0`}
      >
        <CloseIcon />
      </button>
    </header>
  );
}

function SettingsBody({ channel, onClose }: { channel: ChannelView; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const me = useSessionPersonId();
  const people = usePeople().data;
  const name = useChannelName(channel, me);
  const update = useUpdateChannel();
  const dm = channel.kind === "dm";
  const creator = people?.find((p) => p.id === channel.createdById);
  const code = name.code && channel.kind === "project" ? name.code : null;
  const save = (patch: { name?: string; description?: string; topic?: string }) =>
    update.mutateAsync({ id: channel.id, patch }).then(() => undefined);

  return (
    <div className="flex min-h-0 flex-col" data-channel-settings={channel.id}>
      <PanelHeader title={name.label} onClose={onClose} />
      {!dm && (
        <Section title={t("chat.settings.about")}>
          <EditableField
            label={t("chat.settings.name")}
            value={channel.name}
            canEdit={channel.canEditInfo && !channel.isGeneral}
            onSave={(v) => save({ name: v })}
            prefix={code ? `${code} · ` : "# "}
            normalize={(v) => v.toLowerCase().replace(/\s+/g, "-")}
            validate={(v) => (CHANNEL_NAME_RE.test(v) ? null : t("chat.newChannel.nameRule"))}
          />
          <EditableField
            label={t("chat.settings.description")}
            value={channel.description}
            canEdit={channel.canEditInfo}
            onSave={(v) => save({ description: v })}
            empty={t("chat.settings.noDescription")}
          />
          {channel.canRead && (
            <EditableField
              label={t("chat.settings.topic")}
              value={channel.topic}
              canEdit={channel.canEditTopic}
              onSave={(v) => save({ topic: v })}
              empty={t("chat.settings.noTopic")}
            />
          )}
          {!channel.canEditInfo && (
            <p className="text-xs text-ink-muted">
              {code
                ? t("chat.settings.whoCanEdit", { code })
                : t("chat.settings.whoCanEditCompany")}
            </p>
          )}
          {channel.isGeneral && channel.canEditInfo && (
            <p className="text-xs text-ink-muted">{t("chat.settings.generalName")}</p>
          )}
          <p className="text-sm text-ink-muted">
            {channel.visibility === "open"
              ? code
                ? t("chat.settings.openProject", { code })
                : t("chat.settings.openCompany")
              : t("chat.settings.private")}
          </p>
          <p className="text-sm text-ink-muted">
            {t("chat.channel.createdBy", {
              name: creator?.name ?? "",
              date: formatDate(channel.createdAt, i18n.language),
            })}
          </p>
        </Section>
      )}
      {channel.isMember && <NotificationsSection channel={channel} />}
      {channel.kind === "project" && <EventsSection channel={channel} />}
      <MembersSection channel={channel} />
      <DangerZone channel={channel} label={name.label} onClose={onClose} />
    </div>
  );
}

/**
 * Un campo sul posto: il valore come testo; chi può modificarlo ci clicca,
 * Enter salva, Esc annulla. Un salvataggio fallito resta in riga con
 * «Retry» e il valore di prima torna al suo posto.
 */
function EditableField({
  label,
  value,
  canEdit,
  onSave,
  empty,
  prefix,
  normalize = (v) => v,
  validate = () => null,
}: {
  label: string;
  value: string;
  canEdit: boolean;
  onSave: (value: string) => Promise<void>;
  empty?: string;
  prefix?: string;
  normalize?: (value: string) => string;
  /** Il motivo per cui il valore non va (`null` = va): resta in riga, il campo aperto. */
  validate?: (value: string) => string | null;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = (next: string) => {
    if (next.trim() === value) {
      setEditing(false);
      setInvalid(null);
      return;
    }
    const problem = validate(next.trim());
    if (problem) {
      setInvalid(problem);
      setEditing(true);
      return;
    }
    setInvalid(null);
    setSaving(true);
    onSave(next.trim()).then(
      () => {
        setSaving(false);
        setEditing(false);
        setFailed(null);
      },
      () => {
        setSaving(false);
        setEditing(false);
        setFailed(next.trim());
      },
    );
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Escape") {
      // L'Esc annulla il campo, non chiude il pannello.
      e.preventDefault();
      e.stopPropagation();
      setDraft(value);
      setInvalid(null);
      setEditing(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-field={label}>
      <span id={id} className="text-xs font-medium text-ink-muted">
        {label}
      </span>
      {editing ? (
        <input
          ref={input}
          aria-labelledby={id}
          value={draft}
          disabled={saving}
          aria-invalid={invalid ? true : undefined}
          onChange={(e) => {
            setDraft(normalize(e.target.value));
            setInvalid(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (!saving) commit(draft);
          }}
          className={`${inputClass} h-8 py-0 ${invalid ? "border-critical" : ""}`}
        />
      ) : canEdit ? (
        <button
          type="button"
          aria-label={`${label}: ${value || empty || ""}. ${t("chat.settings.edit")}`}
          onClick={() => {
            setDraft(value);
            setFailed(null);
            setEditing(true);
          }}
          className="-mx-1.5 min-h-8 rounded-md px-1.5 py-1 text-left text-md text-ink transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 [overflow-wrap:anywhere]"
        >
          {value ? (
            <>
              {prefix && <span className="num text-ink-muted">{prefix}</span>}
              {value}
            </>
          ) : (
            <span className="text-ink-faint">{empty}</span>
          )}
        </button>
      ) : (
        <p className={`text-md [overflow-wrap:anywhere] ${value ? "text-ink" : "text-ink-faint"}`}>
          {value ? (
            <>
              {prefix && <span className="num text-ink-muted">{prefix}</span>}
              {value}
            </>
          ) : (
            empty
          )}
        </p>
      )}
      {invalid && (
        <p role="alert" className="text-xs text-critical">
          {invalid}
        </p>
      )}
      {failed !== null && (
        <p role="alert" className="text-xs text-critical">
          {t("chat.settings.saveFailed")}{" "}
          <button
            type="button"
            className="font-semibold underline underline-offset-2"
            onClick={() => commit(failed)}
          >
            {t("taskUi.states.retry")}
          </button>
        </p>
      )}
    </div>
  );
}

function NotificationsSection({ channel }: { channel: ChannelView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const setLevel = useSetNotifyLevel();
  const levels: NotifyLevel[] = ["all", "mentions", "muted"];
  return (
    <Section title={t("chat.settings.notifications")}>
      <div role="radiogroup" aria-label={t("chat.settings.notifications")} className="flex flex-col">
        {levels.map((level) => (
          <label
            key={level}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1 hover:bg-ink/4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
          >
            <input
              type="radio"
              name={`notify-${channel.id}`}
              checked={channel.notifyLevel === level}
              onChange={() =>
                setLevel.mutate(
                  { channelId: channel.id, level },
                  { onError: () => toast.error(t("chat.settings.saveFailed")) },
                )
              }
              className="mt-1 accent-[var(--ink)]"
            />
            <span className="text-md text-ink">{t(`chat.settings.levels.${level}`)}</span>
          </label>
        ))}
      </div>
    </Section>
  );
}

function EventsSection({ channel }: { channel: ChannelView }) {
  const { t } = useTranslation();
  const toast = useToast();
  const setEvents = useSetPublishedEvents();
  const toggle = (kind: ChatEventKind) => {
    const next = channel.publishedEvents.includes(kind)
      ? channel.publishedEvents.filter((k) => k !== kind)
      : [...channel.publishedEvents, kind];
    setEvents.mutate(
      { id: channel.id, events: next },
      { onError: () => toast.error(t("chat.settings.saveFailed")) },
    );
  };
  return (
    <Section title={t("chat.settings.events")}>
      {channel.canEditEvents ? (
        <ul className="flex flex-col">
          {CHAT_EVENT_KINDS.map((kind) => {
            const on = channel.publishedEvents.includes(kind);
            return (
              <li key={kind}>
                <label className="flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-1 text-md text-ink hover:bg-ink/4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    onChange={() => toggle(kind)}
                  />
                  <CheckBox checked={on} />
                  {t(`chat.settings.eventKinds.${kind}`)}
                </label>
              </li>
            );
          })}
        </ul>
      ) : channel.publishedEvents.length === 0 ? (
        <p className="text-md text-ink-faint">{t("chat.settings.noEvents")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-md text-ink">
          {CHAT_EVENT_KINDS.filter((k) => channel.publishedEvents.includes(k)).map((kind) => (
            <li key={kind}>{t(`chat.settings.eventKinds.${kind}`)}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-muted">{t("chat.settings.moreRules")}</p>
    </Section>
  );
}

/**
 * I membri: righe 36px con avatar, nome e reparto; «Remove» per chi può
 * (con la conferma in riga), «Add people» con il selettore. Nel «general»
 * del progetto i membri sono quelli del progetto: nessuna aggiunta né
 * rimozione. Chi gestisce un privato senza esserne membro non può
 * aggiungere se stesso. `readOnly`: la pagina del privato non letto.
 */
export function MembersSection({
  channel,
  readOnly = false,
}: {
  channel: ChannelView;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const me = useSessionPersonId();
  const toast = useToast();
  const people = usePeople().data;
  const departments = useDepartments().data;
  const projects = useProjects().data;
  const members = useChannelMembers(channel.id);
  const invite = useInviteMembers();
  const remove = useRemoveMember();
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const project = channel.projectId ? projects?.find((p) => p.id === channel.projectId) : undefined;
  const ids = members.data?.map((m) => m.personId) ?? channel.memberIds;
  const deptOf = (p: Person | undefined) =>
    p?.departmentIds
      .map((id) => departments?.find((d) => d.id === id)?.name)
      .filter(Boolean)
      .join(", ") ?? "";
  // In un progetto solo i suoi membri; chi gestisce un privato senza esserci
  // vede comunque la propria riga, spenta, con il perché.
  const selfBlocked = channel.visibility === "private" && !ids.includes(me);
  const candidates = (people ?? []).filter(
    (p) =>
      !p.isClaude &&
      (project === undefined ||
        project.memberIds.includes(p.id) ||
        (selfBlocked && p.id === me)),
  );
  const canRemove = !readOnly && channel.canRemove;
  const lastOfPrivate = channel.visibility === "private" && ids.length <= 1;

  return (
    <Section
      title={channel.kind === "dm" ? t("chat.settings.participants") : t("chat.settings.members")}
      count={ids.length}
      action={
        !readOnly &&
        channel.canInvite &&
        // Chi gestisce un privato senza leggerlo vede chi c'è, non lo popola.
        channel.canRead &&
        !adding && (
          <button type="button" className={ghostButton} onClick={() => setAdding(true)}>
            {t("chat.settings.addPeople")}
          </button>
        )
      }
    >
      {channel.isGeneral && (
        <p className="text-sm text-ink-muted">
          {t("chat.settings.generalMembers", { code: project?.code ?? "" })}
        </p>
      )}
      {adding && (
        <div className="flex flex-col gap-2 rounded-md border border-rule p-2">
          <PeoplePicker
            label={t("chat.settings.addPeople")}
            candidates={candidates}
            selected={picked}
            autoFocus
            disabledReason={(id) =>
              ids.includes(id)
                ? t("chat.settings.alreadyIn")
                : id === me && channel.visibility === "private"
                  ? t("chat.settings.askMember")
                  : null
            }
            onToggle={(id) =>
              setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
            }
          />
          {project && (
            <p className="text-xs text-ink-muted">
              {t("chat.newChannel.onlyMembers", { code: project.code })}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={smallSecondary}
              onClick={() => {
                setAdding(false);
                setPicked([]);
              }}
            >
              {t("chat.newChannel.cancel")}
            </button>
            <button
              type="button"
              className={smallPrimary}
              disabled={picked.length === 0 || invite.isPending}
              onClick={() =>
                invite.mutate(
                  { id: channel.id, personIds: picked },
                  {
                    onSuccess: () => {
                      setAdding(false);
                      setPicked([]);
                    },
                    onError: () => toast.error(t("chat.settings.addFailed")),
                  },
                )
              }
            >
              {t("chat.settings.add", { count: picked.length })}
            </button>
          </div>
        </div>
      )}
      {members.isPending ? (
        <ul aria-busy="true" className="skeleton-breathe flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex h-9 items-center gap-2.5">
              <span className="size-6 rounded-full bg-ink/8" />
              <span className="h-3 w-32 rounded bg-ink/8" />
            </li>
          ))}
        </ul>
      ) : (
        <ul aria-label={t("chat.settings.members")} className="-mx-1.5 flex flex-col">
          {ids.map((id) => {
            const person = people?.find((p) => p.id === id);
            const removable = canRemove && id !== me && !lastOfPrivate;
            return (
              <li
                key={id}
                data-member={id}
                className="group flex min-h-9 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-md px-1.5 py-1 hover:bg-ink/4"
              >
                <ChatAvatar person={person} size={24} />
                <span className="min-w-0 flex-1 truncate text-md text-ink">
                  {person?.name}
                  {id === me && (
                    <span className="ml-1.5 text-sm text-ink-muted">{t("chat.settings.you")}</span>
                  )}
                  {deptOf(person) && (
                    <span className="ml-2 text-sm text-ink-muted">{deptOf(person)}</span>
                  )}
                </span>
                {removable && confirming !== id && (
                  <button
                    type="button"
                    className={`${ghostButton} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                    aria-label={t("chat.settings.removeNamed", { name: person?.name ?? "" })}
                    onClick={() => setConfirming(id)}
                  >
                    {t("chat.settings.remove")}
                  </button>
                )}
                {confirming === id && (
                  <span role="group" className="flex w-full flex-wrap items-center gap-2 pl-8 text-sm">
                    <span className="text-ink">
                      {t("chat.settings.removeConfirm", { name: person?.name ?? "" })}
                    </span>
                    <button
                      type="button"
                      className="font-semibold text-critical underline-offset-2 hover:underline"
                      onClick={() =>
                        remove.mutate(
                          { id: channel.id, personId: id },
                          {
                            onSuccess: () => setConfirming(null),
                            onError: () => toast.error(t("chat.settings.removeFailed")),
                          },
                        )
                      }
                    >
                      {t("chat.settings.remove")}
                    </button>
                    <button
                      type="button"
                      className="font-medium text-ink-muted hover:text-ink"
                      onClick={() => setConfirming(null)}
                    >
                      {t("chat.newChannel.cancel")}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Lascia, archivia, elimina: in fondo, separati da un filetto; distruttivi in testo critico. */
function DangerZone({
  channel,
  label,
  onClose,
}: {
  channel: ChannelView;
  label: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const leave = useLeaveChannel();
  const join = useJoinChannel();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const dm = channel.kind === "dm";
  // Da un privato o da un gruppo non si rientra da soli: la pagina non c'è più.
  const goAway = () => {
    const code = /^\/p\/([^/]+)\/chat\//.exec(pathname)?.[1];
    void navigate(
      code
        ? { to: "/p/$code/$section", params: { code, section: "chat" } }
        : { to: "/chat", search: { view: "browse" } },
    );
  };
  const anything =
    channel.canLeave || channel.canArchive || channel.canDelete || channel.isGeneral || dm;
  if (!anything) return null;
  return (
    <section className="flex flex-col items-start gap-1 border-t border-rule px-4 py-3">
      {channel.canLeave && channel.isMember && (
        <button
          type="button"
          className={ghostButton}
          onClick={() =>
            leave.mutate(channel.id, {
              onSuccess: () => {
                if (dm || channel.visibility === "private") goAway();
                else onClose();
                // Un aperto si ritrova con «Join»; da un privato non si rientra da soli.
                toast.show(t("chat.settings.left", { name: label }), {
                  ...(channel.visibility === "open" && !dm
                    ? {
                        action: {
                          label: t("chat.settings.undo"),
                          run: () => join.mutate(channel.id),
                        },
                      }
                    : {}),
                });
              },
              onError: () => toast.error(t("chat.channel.leaveFailed")),
            })
          }
        >
          {dm ? t("chat.settings.leaveDm") : t("chat.channel.leave")}
        </button>
      )}
      <ChannelLifecycleActions channel={channel} label={label} />
      {channel.isGeneral && (
        <p className="px-2 text-xs text-ink-muted">{t("chat.settings.generalFixed")}</p>
      )}
      {dm && !channel.canLeave && (
        <p className="px-2 text-xs text-ink-muted">{t("chat.settings.dmFixed")}</p>
      )}
    </section>
  );
}

/**
 * «Archive channel» / «Unarchive» e «Delete channel» con i loro dialoghi:
 * nelle impostazioni e sulla pagina del privato che si gestisce senza
 * leggerlo. Archiviare ha l'Undo nel toast; eliminare no, e chiede il nome.
 */
export function ChannelLifecycleActions({
  channel,
  label,
}: {
  channel: ChannelView;
  label: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const archive = useArchiveChannel();
  const remove = useDeleteChannel();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  const setArchived = (archived: boolean, after?: () => void) =>
    archive.mutate(
      { id: channel.id, archived },
      {
        onSuccess: after,
        onError: () =>
          toast.error(
            archived ? t("chat.settings.archiveFailed") : t("chat.channel.unarchiveFailed"),
          ),
      },
    );
  return (
    <>
      {channel.canArchive &&
        (channel.archived ? (
          <button type="button" className={ghostButton} onClick={() => setArchived(false)}>
            {t("chat.channel.unarchive")}
          </button>
        ) : (
          <button
            type="button"
            className={dangerText}
            onClick={() => setDialog("archive")}
          >
            {t("chat.settings.archive")}
          </button>
        ))}
      {channel.canDelete && (
        <button
          type="button"
          className={dangerText}
          onClick={() => setDialog("delete")}
        >
          {t("chat.settings.delete")}
        </button>
      )}
      {dialog === "archive" && (
        <Dialog
          title={t("chat.settings.archiveTitle", { name: label })}
          description={t("chat.settings.archiveBody")}
          width={440}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className={secondaryButton} onClick={() => setDialog(null)}>
                {t("chat.newChannel.cancel")}
              </button>
              <button
                type="button"
                data-autofocus
                className={primaryButton}
                disabled={archive.isPending}
                onClick={() =>
                  setArchived(true, () => {
                    setDialog(null);
                    toast.show(t("chat.settings.archived", { name: label }), {
                      action: { label: t("chat.settings.undo"), run: () => setArchived(false) },
                    });
                  })
                }
              >
                {t("chat.settings.archiveAction")}
              </button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
      {dialog === "delete" && (
        <DeleteChannelDialog
          channel={channel}
          label={label}
          pending={remove.isPending}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            remove.mutate(channel.id, {
              onSuccess: () => {
                setDialog(null);
                toast.show(t("chat.settings.deleted", { name: label }));
                const code = /^\/p\/([^/]+)\/chat\//.exec(pathname)?.[1];
                void navigate(
                  code
                    ? { to: "/p/$code/$section", params: { code, section: "chat" } }
                    : { to: "/chat", search: { view: "browse" } },
                );
              },
              onError: () => toast.error(t("chat.settings.deleteFailed")),
            })
          }
        />
      )}
    </>
  );
}

/**
 * Elimina, per tutti e per sempre: si conferma scrivendo il nome. Nessun
 * conteggio dei messaggi — chi gestisce un privato non ne legge nulla, e il
 * dialogo è lo stesso per tutti.
 */
function DeleteChannelDialog({
  channel,
  label,
  pending,
  onClose,
  onConfirm,
}: {
  channel: ChannelView;
  label: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const id = useId();
  const ok = typed.trim() === channel.name;
  return (
    <Dialog
      title={t("chat.settings.deleteTitle", { name: label })}
      description={t("chat.settings.deleteBody")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("chat.newChannel.cancel")}
          </button>
          <button
            type="submit"
            form="delete-channel"
            disabled={!ok || pending}
            className="inline-flex h-8 shrink-0 items-center rounded-md border border-critical/60 px-3 text-sm font-semibold text-critical transition-colors duration-[var(--duration-fast)] ease-out hover:bg-critical/10 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {t("chat.settings.delete")}
          </button>
        </>
      }
    >
      <form
        id="delete-channel"
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm();
        }}
      >
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {t("chat.settings.typeName", { name: channel.name })}
        </label>
        <input
          id={id}
          data-autofocus
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          className={inputClass}
        />
      </form>
    </Dialog>
  );
}
