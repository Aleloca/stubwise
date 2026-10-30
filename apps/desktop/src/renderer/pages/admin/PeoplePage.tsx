import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  useAdminPeople,
  useDepartments,
  useRoles,
  type PeopleFilter,
  type PersonRow,
} from "../../data/queries";
import { PEOPLE_STATUSES } from "../../data/routes";
import { can, useViewer } from "../../data/viewer";
import { inputClass } from "../../tasks-ui/Dialog";
import { Chip } from "../../tasks-ui/FilterBar";
import { CheckItem } from "../../tasks-ui/Menu";
import { PageError } from "../../tasks-ui/PageStates";
import { OpenCircleGlyph, TriangleGlyph } from "../preferences/glyphs";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { InviteDialog } from "./InviteDialog";
import { AdminAvatar, useShortDate } from "./parts";

// People (shape admin-people.md §3): chiunque la legge. In testa h1, la riga
// in prosa e, a chi invita, «Invite someone»; sotto la barra dei filtri
// (ricerca, reparto, ruolo, stato — nell'indirizzo) e l'elenco: una riga di
// 52 px per persona, gli inviti in sospeso come righe «Invited» [PE 3]. Tutta
// la riga porta alla pagina della persona [PE 2]; ↑/↓ fra le righe.

type Status = (typeof PEOPLE_STATUSES)[number];

/** Di base: le attive e gli inviti in sospeso. */
const DEFAULT_STATUSES: Status[] = ["active", "invited"];

/** Quanti codici di progetto si leggono nella riga prima di «+2». */
const CODES_SHOWN = 4;

interface Search {
  find?: string;
  depts?: string;
  roles?: string;
  statuses?: string;
  invite?: string;
}

const listOf = (value: string | undefined): string[] => (value ? value.split(",") : []);
const valueOf = (list: string[]): string | undefined => (list.length ? list.join(",") : undefined);

export function PeoplePage() {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Search;
  const canInvite = can(viewer, "users.invite");
  const [inviting, setInviting] = useState(search.invite === "1");
  const inviteButton = useRef<HTMLButtonElement>(null);

  // ⌘K «Invite someone» arriva con `?invite=1`: il dialogo si apre e il parametro se ne va.
  useEffect(() => {
    if (search.invite !== "1") return;
    if (canInvite) setInviting(true);
    void navigate({ to: ".", search: (prev: Search) => ({ ...prev, invite: undefined }), replace: true });
  }, [search.invite, canInvite, navigate]);

  const depts = listOf(search.depts);
  const roles = listOf(search.roles);
  const statuses = search.statuses
    ? (listOf(search.statuses) as Status[])
    : DEFAULT_STATUSES;
  const find = search.find ?? "";
  const filter: PeopleFilter = {
    q: find || undefined,
    departmentIds: depts.length ? depts : undefined,
    instanceRoleIds: roles.length ? roles : undefined,
    statuses,
  };
  const people = useAdminPeople(filter);
  const filtered = !!find || depts.length > 0 || roles.length > 0 || !!search.statuses;

  const set = (patch: Partial<Search>) =>
    void navigate({ to: ".", search: (prev: Search) => ({ ...prev, ...patch }), replace: true });
  const clear = () =>
    set({ find: undefined, depts: undefined, roles: undefined, statuses: undefined });

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[960px]">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
            {t("admin.sections.people")}
          </h1>
          {canInvite && (
            <button
              ref={inviteButton}
              type="button"
              className={primaryButton}
              onClick={() => setInviting(true)}
            >
              {t("admin.people.invite")}
            </button>
          )}
        </div>
        <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">
          {t("admin.people.intro")}
        </p>
        <FilterRow
          find={find}
          depts={depts}
          roles={roles}
          statuses={statuses}
          customStatuses={!!search.statuses}
          canInvite={canInvite}
          onChange={set}
        />
        <div className="mt-3 border-t border-rule">
          {people.isPending ? (
            <PeopleSkeleton />
          ) : people.isError ? (
            <PageError message={t("admin.people.loadError")} onRetry={() => void people.refetch()} />
          ) : (
            <PeopleList
              rows={people.data}
              filtered={filtered}
              onClear={clear}
              onInvite={canInvite ? () => setInviting(true) : undefined}
            />
          )}
        </div>
      </div>
      {inviting && (
        <InviteDialog
          onClose={() => {
            setInviting(false);
            inviteButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}

/** La barra: ricerca mentre si scrive, e i tre menu a scelta multipla. */
function FilterRow({
  find,
  depts,
  roles,
  statuses,
  customStatuses,
  canInvite,
  onChange,
}: {
  find: string;
  depts: string[];
  roles: string[];
  statuses: Status[];
  customStatuses: boolean;
  canInvite: boolean;
  onChange: (patch: Partial<Search>) => void;
}) {
  const { t } = useTranslation();
  const departments = useDepartments().data ?? [];
  const instanceRoles = (useRoles().data ?? []).filter((r) => r.scope === "instance");
  const [open, setOpen] = useState<null | "dept" | "role" | "status">(null);
  const [text, setText] = useState(find);
  // L'indirizzo cambiato da fuori («Clear filters») riporta il campo.
  useEffect(() => setText(find), [find]);

  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  const names = (ids: string[], all: { id: string; name: string }[]) =>
    ids.length ? ids.map((id) => all.find((x) => x.id === id)?.name ?? id).join(", ") : null;
  const statusOptions = PEOPLE_STATUSES.filter((s) => s !== "invited" || canInvite);
  const shownStatuses = statuses.filter((s) => statusOptions.includes(s));

  return (
    <div role="group" aria-label={t("admin.people.listLabel")} className="mt-5 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={text}
        aria-label={t("admin.people.findLabel")}
        placeholder={t("admin.people.find")}
        onChange={(e) => {
          setText(e.target.value);
          onChange({ find: e.target.value.trim() || undefined });
        }}
        className={`${inputClass} h-7 max-w-64 py-0 text-sm`}
      />
      <Chip
        name={t("admin.people.department")}
        summary={names(depts, departments)}
        open={open === "dept"}
        onOpenChange={(o) => setOpen(o ? "dept" : null)}
        onRemove={() => onChange({ depts: undefined })}
      >
        {departments.map((d) => (
          <CheckItem
            key={d.id}
            checked={depts.includes(d.id)}
            onToggle={() => onChange({ depts: valueOf(toggle(depts, d.id)) })}
          >
            {d.name}
          </CheckItem>
        ))}
      </Chip>
      <Chip
        name={t("admin.people.role")}
        summary={names(roles, instanceRoles)}
        open={open === "role"}
        onOpenChange={(o) => setOpen(o ? "role" : null)}
        onRemove={() => onChange({ roles: undefined })}
      >
        {instanceRoles.map((r) => (
          <CheckItem
            key={r.id}
            checked={roles.includes(r.id)}
            onToggle={() => onChange({ roles: valueOf(toggle(roles, r.id)) })}
          >
            {r.name}
          </CheckItem>
        ))}
      </Chip>
      <Chip
        name={t("admin.people.status")}
        summary={shownStatuses.map((s) => t(`admin.people.statuses.${s}`)).join(", ") || null}
        open={open === "status"}
        onOpenChange={(o) => setOpen(o ? "status" : null)}
        // Lo stato ha sempre un valore: la × riporta quello di base.
        onRemove={customStatuses ? () => onChange({ statuses: undefined }) : undefined}
      >
        {statusOptions.map((s) => (
          <CheckItem
            key={s}
            checked={statuses.includes(s)}
            onToggle={() => {
              const next = toggle(statuses, s) as Status[];
              const isDefault =
                next.length === DEFAULT_STATUSES.length &&
                DEFAULT_STATUSES.every((x) => next.includes(x));
              onChange({ statuses: isDefault ? undefined : valueOf(next) });
            }}
          >
            {t(`admin.people.statuses.${s}`)}
          </CheckItem>
        ))}
      </Chip>
    </div>
  );
}

/** Le righe, con ↑/↓ fra l'una e l'altra; gli stati vuoti in parole. */
function PeopleList({
  rows,
  filtered,
  onClear,
  onInvite,
}: {
  rows: PersonRow[];
  filtered: boolean;
  onClear: () => void;
  onInvite?: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const list = useRef<HTMLUListElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...(list.current?.querySelectorAll<HTMLElement>("a[data-person-row]") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    links[Math.max(0, Math.min(links.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  if (rows.length === 0 && filtered)
    return (
      <div className="flex flex-col items-start gap-3 py-8">
        <p className="text-md text-ink">{t("admin.people.noMatch")}</p>
        <button type="button" className={secondaryButton} onClick={onClear}>
          {t("admin.people.clearFilters")}
        </button>
      </div>
    );
  const onlyMe = !filtered && rows.length <= 1 && rows.every((r) => r.personId === viewer.personId);
  return (
    <>
      <ul
        ref={list}
        aria-label={t("admin.people.listLabel")}
        onKeyDown={onKeyDown}
        className="@container"
      >
        {rows.map((row) => (
          <li key={row.personId} className="border-b border-rule">
            {row.invite ? <InviteRow row={row} /> : <PersonRowLink row={row} />}
          </li>
        ))}
      </ul>
      {onlyMe && (
        <div className="flex flex-col items-start gap-3 py-8">
          <p className="text-md text-ink">{t("admin.people.onlyYou")}</p>
          {onInvite && (
            <button type="button" className={primaryButton} onClick={onInvite}>
              {t("admin.people.invite")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

const rowLink =
  "grid min-h-[52px] grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-1.5 pr-3 pl-2 outline-none transition-colors duration-[var(--duration-fast)] ease-out [grid-template-areas:'av_top_codes'_'av_bottom_codes'] hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus @max-[720px]:[grid-template-areas:'av_top_top'_'av_bottom_codes']";

/** Una persona: nome e ruolo d'istanza, poi email e reparti; i progetti a destra. */
function PersonRowLink({ row }: { row: PersonRow }) {
  const { t } = useTranslation();
  const date = useShortDate();
  const off = row.status === "deactivated";
  const codes = row.projects.slice(0, CODES_SHOWN);
  const rest = row.projects.length - codes.length;
  const projectsTitle = row.projects
    .map((p) => t("admin.people.projectAs", { code: p.code, role: p.role }))
    .join("\n");
  return (
    <Link
      to="/admin/people/$personId"
      params={{ personId: row.personId }}
      data-person-row
      className={rowLink}
    >
      <span className="[grid-area:av] self-start pt-0.5">
        <AdminAvatar initials={row.avatar} muted={off} />
      </span>
      <span className="flex min-w-0 items-baseline gap-2 [grid-area:top]">
        <span
          title={row.name}
          className={`min-w-0 truncate text-md font-semibold ${off ? "text-ink-muted" : "text-ink"}`}
        >
          {row.name}
        </span>
        <span className="shrink-0 text-sm text-ink-muted">
          {row.instanceRole?.name ?? t("admin.people.noRole")}
        </span>
        {off && row.deactivatedAt && (
          <span className="flex shrink-0 items-center gap-1 text-sm text-ink-muted">
            <OpenCircleGlyph size={12} />
            {t("admin.people.deactivatedOn", { date: date(row.deactivatedAt) })}
          </span>
        )}
      </span>
      <span
        title={row.email}
        className="min-w-0 truncate text-sm text-ink-muted [grid-area:bottom]"
      >
        {[row.email, ...row.departments.map((d) => d.name)].join(" · ")}
      </span>
      <span
        title={projectsTitle || undefined}
        className="num flex shrink-0 items-center justify-end gap-2 text-xs font-semibold tracking-[0.02em] text-ink-muted [grid-area:codes]"
      >
        {codes.map((p) => (
          <span key={p.code}>{p.code}</span>
        ))}
        {rest > 0 && <span className="text-ink-faint">+{rest}</span>}
        {row.projects.length === 0 && (
          <span className="font-normal tracking-normal text-ink-faint">
            {t("admin.people.noProjects")}
          </span>
        )}
      </span>
    </Link>
  );
}

/** Un invito in sospeso: l'email al posto del nome, la scadenza, i progetti offerti e chi ha invitato. */
function InviteRow({ row }: { row: PersonRow }) {
  const { t } = useTranslation();
  const date = useShortDate();
  const invite = row.invite!;
  const offered = row.projects
    .map((p) => t("admin.people.projectAs", { code: p.code, role: p.role }))
    .join(" · ");
  return (
    <Link
      to="/admin/people/invites/$inviteId"
      params={{ inviteId: invite.id }}
      data-person-row
      className={rowLink}
    >
      <span className="[grid-area:av] self-start pt-0.5">
        <AdminAvatar initials="" invite />
      </span>
      <span className="flex min-w-0 items-baseline gap-2 [grid-area:top]">
        <span title={row.email} className="min-w-0 truncate text-md font-semibold text-ink">
          {row.email}
        </span>
        {invite.expired ? (
          <span className="flex shrink-0 items-center gap-1 text-sm text-warning">
            <TriangleGlyph size={12} />
            {t("admin.people.expired", { date: date(invite.expiresAt) })}
          </span>
        ) : (
          <span className="shrink-0 text-sm text-ink-muted">
            {t("admin.people.invitedExpires", { date: date(invite.expiresAt) })}
          </span>
        )}
      </span>
      <span className="min-w-0 truncate text-sm text-ink-muted [grid-area:bottom]">
        {[offered, t("admin.people.invitedBy", { name: invite.invitedByName })]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="[grid-area:codes]" />
    </Link>
  );
}

/** Otto righe scheletro sotto la barra, con la forma di una riga di persona. */
const SKELETON_WIDTHS = ["38%", "30%", "44%", "34%", "40%", "28%", "36%", "42%"];

function PeopleSkeleton() {
  const { t } = useTranslation();
  const widths = SKELETON_WIDTHS;
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {widths.map((w, i) => (
        <div key={i} className="flex h-[52px] items-center gap-3 border-b border-rule pl-2">
          <span className="size-7 rounded-full bg-ink/8" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-2.5 rounded-sm bg-ink/8" style={{ width: w }} />
            <span className="h-2 w-1/4 rounded-sm bg-ink/6" />
          </span>
          <span className="mr-3 h-2.5 w-20 rounded-sm bg-ink/8" />
        </div>
      ))}
    </div>
  );
}
