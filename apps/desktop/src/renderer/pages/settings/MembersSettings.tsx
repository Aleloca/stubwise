import {
  Link,
  useBlocker,
  useNavigate,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { canSeeAdminSection } from "../../data/adminSections";
import {
  useMemberPreview,
  useMembers,
  useProject,
  useRemoveProjectMember,
  useSaveMember,
  useSessionPersonId,
  type MemberPreview,
  type MemberRow,
  type ProjectMembersView,
  type SourceView,
} from "../../data/queries";
import type { Project } from "../../data/types";
import { useViewer } from "../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { useReauth } from "../../layout/useReauth";
import { inputClass } from "../../tasks-ui/Dialog";
import { PageSkeleton } from "../../tasks-ui/PageStates";
import { useToast } from "../../tasks-ui/Toast";
import { RolePicker } from "../admin/InviteDialog";
import { PermissionTable, type RowContext } from "../admin/PermissionTable";
import {
  AdminAvatar,
  QuietLine,
  SaveBar,
  reasonWords,
  useMissingWords,
  usePermissionWords,
  useRefusalWords,
  useShortDate,
  type UiRefusal,
} from "../admin/parts";
import { OpenCircleGlyph, TriangleGlyph } from "../preferences/glyphs";
import { WriteError, refusalOf, rowButton } from "../preferences/parts";
import { CloseIcon, InlineConfirm } from "../task/parts";
import { primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { AddMemberDialog } from "./AddMemberDialog";
import { SettingsFrame } from "./SettingsFrame";
import { WhoCanLink } from "../../components/WhoCanLink";

// Progetto → Settings → Members (shape admin-roles-members.md, «Members»):
// chi lavora sul progetto, col ruolo in parola e i permessi in più in prosa,
// ognuno con la sua fonte. Una riga apre il pannello del membro
// (`?member=`, `MemberPanelHost`) — in sola lettura per chi non gestisce i
// membri [RM 5]. «Add member» (`?addMember=`) solo per chi li gestisce. Né
// Claude né i full admin sono righe: la riga sotto l'elenco lo dice. Cosa è
// spento e perché lo dice il livello dati (`grantable`, `addableMissing`,
// `previewMember`): qui non si ricalcola nessuna regola.

/** Oltre questo numero di membri, sopra l'elenco compare «Find a member». */
const FIND_FROM = 20;
/** Quanto resta in cima, segnata, la riga di chi è appena entrato. */
const JUST_ADDED_MS = 2000;

const membersPath = /^\/p\/([A-Z]{2,4})\/settings\/members$/;

/** Il nome di battesimo, per la fonte breve nella riga («given by Roberta, Oct 29»). */
const firstName = (name: string) => name.split(" ")[0] ?? name;

/** La fonte breve di un permesso in più, nella riga dell'elenco. */
function useShortSource() {
  const { t } = useTranslation();
  const date = useShortDate();
  return (s: SourceView): string => {
    switch (s.kind) {
      case "grant":
        if (s.origin === "seed") return t("settings.members.short.seed");
        if (s.origin === "draft") return t("settings.members.short.draft");
        return s.grantedByName
          ? t("settings.members.short.given", { name: firstName(s.grantedByName), date: date(s.at) })
          : t("settings.members.short.givenNoName", { date: date(s.at) });
      case "department":
        return t("settings.members.short.department", { name: s.departmentName });
      case "role":
        return s.roleName;
      case "full_admin":
        return t("admin.person.projects.fullAdmin");
    }
  };
}

/** La fonte per esteso, nel pannello («Given by Roberta Fontana on Oct 29»). */
function useLongSource(departmentsLink: boolean) {
  const { t } = useTranslation();
  const date = useShortDate();
  return (s: SourceView): string => {
    switch (s.kind) {
      case "grant":
        if (s.origin === "seed") return t("settings.members.panel.source.seed");
        if (s.origin === "draft") return t("settings.members.panel.source.draft");
        return s.grantedByName
          ? t("settings.members.panel.source.given", { name: s.grantedByName, date: date(s.at) })
          : t("settings.members.panel.source.givenNoName", { date: date(s.at) });
      case "department":
        return t(
          departmentsLink
            ? "settings.members.panel.source.departmentManage"
            : "settings.members.panel.source.department",
          { name: s.departmentName },
        );
      case "role":
        return t("settings.members.panel.source.role", { name: s.roleName });
      case "full_admin":
        return t("admin.permissionTable.included");
    }
  };
}

export function MembersSettings({ project }: { project: Project }) {
  const { t } = useTranslation();
  const members = useMembers(project.id);
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { member?: string; addMember?: string };
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const canManage = members.data?.canManage === true;

  useEffect(() => {
    if (!justAdded) return;
    const timer = window.setTimeout(() => setJustAdded(null), JUST_ADDED_MS);
    return () => window.clearTimeout(timer);
  }, [justAdded]);

  const setSearch = (patch: { member?: string; addMember?: string }) =>
    void navigate({
      to: "/p/$code/settings/$section",
      params: { code: project.code, section: "members" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, ...patch })) as never,
    });
  const addButton = canManage ? (
    <button type="button" className={primaryButton} onClick={() => setSearch({ addMember: "1" })}>
      {t("settings.members.add")}
    </button>
  ) : null;

  return (
    <SettingsFrame
      title={t("settings.sections.members")}
      intro={t("settings.members.intro", { code: project.code })}
      action={addButton}
    >
      {members.isPending ? (
        <div className="border-t border-rule">
          <PageSkeleton rows={6} />
        </div>
      ) : members.isError ? (
        <div role="alert" className="flex items-center gap-3 border-t border-rule py-3">
          <p className="text-md text-ink">
            {t("settings.members.loadError", { code: project.code })}
          </p>
          <button type="button" className={secondaryButton} onClick={() => void members.refetch()}>
            {t("taskUi.states.retry")}
          </button>
        </div>
      ) : members.data.members.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border-t border-rule py-8">
          <p className="max-w-[56ch] text-md text-ink-muted">
            {canManage
              ? t("settings.members.empty", { code: project.code })
              : t("settings.members.emptyRead")}
          </p>
          {addButton && (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setSearch({ addMember: "1" })}
            >
              {t("settings.members.add")}
            </button>
          )}
          <FullAdminNote />
        </div>
      ) : (
        <>
          <MemberList
            project={project}
            rows={members.data.members}
            selected={search.member}
            justAdded={justAdded}
            onOpen={(id) => setSearch({ member: id === search.member ? undefined : id })}
          />
          <FullAdminNote />
        </>
      )}
      {search.addMember && members.data && canManage && (
        <AddMemberDialog
          project={project}
          view={members.data}
          preselect={search.addMember === "1" ? undefined : search.addMember}
          onClose={() => setSearch({ addMember: undefined })}
          onAdded={(personId) => {
            setJustAdded(personId);
            setSearch({ addMember: undefined });
          }}
        />
      )}
    </SettingsFrame>
  );
}

function FullAdminNote() {
  const { t } = useTranslation();
  return <p className="mt-4 text-sm text-ink-muted">{t("settings.members.fullAdmins")}</p>;
}

/** Le righe, con ↑/↓ fra l'una e l'altra; la riga aperta nel pannello è segnata. */
function MemberList({
  project,
  rows,
  selected,
  justAdded,
  onOpen,
}: {
  project: Project;
  rows: MemberRow[];
  selected: string | undefined;
  justAdded: string | null;
  onOpen: (personId: string) => void;
}) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const q = find.trim().toLowerCase();
  const shown = rows
    .filter((r) => !q || `${r.name} ${r.email}`.toLowerCase().includes(q))
    // Chi è appena entrato sta in cima per due secondi, poi va al suo posto.
    .sort((a, b) => Number(b.personId === justAdded) - Number(a.personId === justAdded));
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-member-row]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <div className="@container">
      {rows.length > FIND_FROM && (
        <input
          type="search"
          value={find}
          aria-label={t("settings.members.findLabel")}
          placeholder={t("settings.members.find")}
          onChange={(e) => setFind(e.target.value)}
          className={`${inputClass} mb-3 h-7 max-w-64 py-0 text-sm`}
        />
      )}
      {shown.length === 0 ? (
        <p className="border-t border-rule py-4 text-md text-ink-muted">
          {t("settings.members.noMatch")}
        </p>
      ) : (
        <ul
          aria-label={t("settings.members.listLabel", { code: project.code })}
          onKeyDown={onKeyDown}
          className="border-t border-rule"
        >
          {shown.map((row) => (
            <MemberRowItem
              key={row.personId}
              row={row}
              open={row.personId === selected}
              fresh={row.personId === justAdded}
              onOpen={() => onOpen(row.personId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MemberRowItem({
  row,
  open,
  fresh,
  onOpen,
}: {
  row: MemberRow;
  open: boolean;
  fresh: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const words = usePermissionWords();
  const short = useShortSource();
  const off = row.status === "deactivated";
  const extras = row.extra.map((x) =>
    t("settings.members.extra", {
      permission: words(x.permission),
      source: x.sources.map(short).join(" · "),
    }),
  );
  // Largo: fino a due permessi in più, poi «+N more»; stretto (1024): uno solo.
  const more = (shownCount: number) =>
    extras.length > shownCount
      ? t("settings.members.more", { count: extras.length - shownCount })
      : null;
  return (
    <li className="border-b border-rule">
      <button
        type="button"
        data-member-row={row.personId}
        aria-current={open || undefined}
        onClick={onOpen}
        className={`flex min-h-13 w-full items-start gap-3 rounded-md px-1 py-2 text-left transition-colors duration-[var(--duration-fast)] ease-out ${open ? "bg-ink/10 hover:bg-ink/10" : fresh ? "bg-ink/6" : "hover:bg-ink/4"}`}
      >
        <span className="pt-0.5">
          <AdminAvatar initials={row.avatar} muted={off} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`min-w-0 truncate text-md font-medium ${off ? "text-ink-muted" : "text-ink"}`}
            >
              {off ? t("taskUi.deactivatedName", { name: row.name }) : row.name}
            </span>
            <span className="shrink-0 text-sm text-ink-muted">{row.role.name}</span>
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-1 text-sm text-ink-muted">
            <span className="min-w-0 truncate">{row.email}</span>
            {extras[0] && (
              <span className="min-w-0">
                <span aria-hidden="true">· </span>
                {extras[0]}
              </span>
            )}
            {extras[1] && (
              <span className="hidden min-w-0 @min-[720px]:inline">
                <span aria-hidden="true">· </span>
                {extras[1]}
              </span>
            )}
            {more(1) && (
              <span className="num shrink-0 @min-[720px]:hidden">
                <span aria-hidden="true">· </span>
                {more(1)}
              </span>
            )}
            {more(2) && (
              <span className="num hidden shrink-0 @min-[720px]:inline">
                <span aria-hidden="true">· </span>
                {more(2)}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

// --- il pannello del membro ---------------------------------------------------------

/**
 * L'host del pannello (`/p/<CODE>/settings/members?member=<id>`), montato
 * nell'`AppLayout` accanto alla pagina: affiancato da 1200 px, sovrapposto
 * sotto. Cambiare persona lo chiude; un `?member=` che non è fra i membri lo
 * chiude in silenzio.
 */
export function MemberPanelHost() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const code = membersPath.exec(pathname)?.[1];
  const search = useSearch({ strict: false }) as { member?: string };
  if (!code || !search.member) return null;
  return <MemberPanelForProject code={code} personId={search.member} />;
}

function MemberPanelForProject({ code, personId }: { code: string; personId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const me = useSessionPersonId();
  const project = useProject(code).data;
  const members = useMembers(project?.id);
  const close = useCallback(() => {
    void navigate({
      to: "/p/$code/settings/$section",
      params: { code, section: "members" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, member: undefined })) as never,
    });
  }, [navigate, code]);
  const [viewerId, setViewerId] = useState(me);
  useEffect(() => {
    if (viewerId !== me) {
      setViewerId(me);
      close();
    }
  }, [viewerId, me, close]);
  const row = members.data?.members.find((m) => m.personId === personId);
  const unknown = members.data !== undefined && !row;
  useEffect(() => {
    if (unknown) close();
  }, [unknown, close]);
  if (!project || !members.data || !row || viewerId !== me) return null;
  return (
    <DetailPanel
      mode={wide ? "docked" : "overlay"}
      label={t("settings.members.panel.label", { name: row.name, code: project.code })}
      onClose={close}
    >
      <MemberPanel
        key={`${row.personId}:${me}`}
        project={project}
        row={row}
        view={members.data}
        onClose={close}
      />
    </DetailPanel>
  );
}

export function MemberPanel({
  project,
  row,
  view,
  onClose,
}: {
  project: Project;
  row: MemberRow;
  view: ProjectMembersView;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const me = useSessionPersonId();
  const toast = useToast();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const missingWords = useMissingWords();
  const words = usePermissionWords();
  const save = useSaveMember();
  const manage = view.canManage;
  const code = project.code;
  const name = row.name;
  const self = row.personId === me;
  const [roleId, setRoleId] = useState(row.role.id);
  const [granted, setGranted] = useState<string[]>(row.granted);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const roleChanged = roleId !== row.role.id;
  const changes =
    Number(roleChanged) +
    granted.filter((p) => !row.granted.includes(p)).length +
    row.granted.filter((p) => !granted.includes(p)).length;
  const dirty = changes > 0;

  // Chiudere, aprire un altro membro o lasciare la pagina con modifiche chiede prima.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirtyRef.current &&
      (next.pathname !== current.pathname ||
        (next.search as { member?: string }).member !== row.personId),
    enableBeforeUnload: false,
    withResolver: true,
  });

  const previewQuery = useMemberPreview(project.id, row.personId, { roleId, granted });
  const preview: MemberPreview | undefined = previewQuery.data;
  const longSource = useLongSource(canSeeAdminSection(viewer, "departments"));
  const allowed = new Set(view.grantable.filter((g) => g.allowed).map((g) => g.permission));

  const discard = () => {
    setRoleId(row.role.id);
    setGranted(row.granted);
    setError(null);
  };
  const toggle = (p: string) =>
    setGranted((g) => (g.includes(p) ? g.filter((x) => x !== p) : [...g, p]));

  /** Il motivo per cui la bozza non si salva, in parole (prima, non dopo). */
  const draftBlock = (block: string | null): string | null => {
    if (!block) return null;
    if (block === "last_members_manager")
      return self
        ? t("settings.members.refusal.lastManagerSelf", { code })
        : t("settings.members.refusal.lastManagerOther", { name, code });
    return reasonWords(t, block, { name });
  };
  const escalationWords = (missing: string[]) =>
    missing.length === 1
      ? t("settings.members.refusal.escalationOne", { permission: words(missing[0]!), code })
      : t("settings.members.refusal.escalationMany", { missing: missingWords(missing) });

  const blockedWhy = preview
    ? preview.missing.length > 0
      ? escalationWords(preview.missing)
      : draftBlock(preview.block)
    : null;

  async function onSave() {
    setError(null);
    setSaving(true);
    const result = await reauth(
      () => save.mutateAsync([project.id, row.personId, { roleId, granted }]),
      { action: t("settings.members.panel.saveAction", { name, code }) },
    ).catch(() => null);
    setSaving(false);
    if (result === null) return setError(t("settings.members.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "reauth_cancelled")
        return void toast.show(t("admin.refusal.reauthCancelled"));
      if (refusal.error === "escalation")
        return setError(escalationWords((refusal as { missing: string[] }).missing));
      if (refusal.error === "invalid" && refusal.reason === "last_members_manager")
        return setError(draftBlock(refusal.reason));
      return setError(refusalWords(refusal, { name }));
    }
    dirtyRef.current = false;
    toast.show(t("settings.members.panel.saved"));
  }

  // Le righe della tabella: le fonti dalla bozza letta dal livello dati.
  const sourcesOf = (p: string) => preview?.permissions.find((x) => x.permission === p)?.sources;
  const context = (p: string): RowContext | null => {
    const sources = sourcesOf(p);
    if (sources) {
      const fixed = sources.some((s) => s.kind !== "grant");
      return {
        short: sources.map(longSource).join(" · "),
        locked: !manage || fixed,
        forcedOn: fixed,
      };
    }
    // Nel pannello la frase intera, sotto il nome: è il rifiuto detto prima (shape §2).
    if (manage && !allowed.has(p))
      return { short: t("settings.members.panel.blockedWhy", { code }), locked: true };
    return null;
  };
  const off = row.status === "deactivated";
  const roleName = view.roleChoices.find((r) => r.roleId === roleId)?.name ?? row.role.name;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-6 px-5 pt-4 pb-6">
        <header className="flex items-start gap-3">
          <AdminAvatar initials={row.avatar} muted={off} />
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="truncate text-lg font-semibold text-ink">
              {off ? t("taskUi.deactivatedName", { name }) : name}
            </h2>
            <p title={row.email} className="truncate text-sm text-ink-muted">
              {row.email}
            </p>
            {canSeeAdminSection(viewer, "people") && (
              <Link
                to="/admin/people/$personId"
                params={{ personId: row.personId }}
                className="mt-1 w-fit rounded-sm text-sm font-medium text-ink underline underline-offset-2 hover:text-ink-muted"
              >
                {t("settings.members.panel.openInPeople")}
              </Link>
            )}
          </div>
          <button
            type="button"
            aria-label={t("settings.members.panel.close")}
            onClick={onClose}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        {(!manage || off || self) && (
          <div className="flex flex-col gap-1.5">
            {self && <QuietLine>{t("settings.members.panel.you")}</QuietLine>}
            {off && (
              <QuietLine>
                <OpenCircleGlyph size={12} />
                {t("settings.members.panel.deactivated", { name })}
              </QuietLine>
            )}
            {!manage && (
              <QuietLine>
                <OpenCircleGlyph size={12} />
                <span>
                  {t("settings.members.panel.readOnly", { code })}{" "}
                  <WhoCanLink action="manageMembers" projectId={project.id} projectCode={code} />
                </span>
              </QuietLine>
            )}
          </div>
        )}

        <PanelPart title={t("settings.members.panel.role")}>
          {manage ? (
            <RolePicker
              label={t("settings.members.panel.roleLabel", { code })}
              roles={preview?.roleChoices ?? view.roleChoices}
              value={roleId}
              onChange={setRoleId}
            />
          ) : (
            <p className="text-md text-ink">{roleName}</p>
          )}
        </PanelPart>

        <PanelPart title={t("settings.members.panel.can")}>
          {manage && (
            <p className="mb-3 text-sm text-pretty text-ink-muted">
              {t("settings.members.panel.canIntro")}
            </p>
          )}
          {preview ? (
            <PermissionTable
              scope="project"
              label={t("settings.members.panel.tableLabel", { name, code })}
              checked={new Set(granted)}
              onToggle={manage ? toggle : undefined}
              context={context}
            />
          ) : previewQuery.isError ? (
            <WriteError
              message={t("settings.members.panel.loadError", { name })}
              onRetry={() => void previewQuery.refetch()}
            />
          ) : (
            <PageSkeleton rows={6} />
          )}
        </PanelPart>

        {manage && (
          <RemoveFromProject
            project={project}
            row={row}
            block={preview?.removeBlock ?? null}
            self={self}
            onRemoved={() => {
              dirtyRef.current = false;
              onClose();
            }}
          />
        )}
      </div>

      {manage && (dirty || blocker.status === "blocked") && (
        <SaveBar inset="px-5">
          {blocker.status === "blocked" ? (
            <InlineConfirm
              message={t("settings.members.panel.discardAsk", { count: changes })}
              confirm={t("settings.members.panel.discard")}
              cancelLabel={t("settings.members.panel.keep")}
              onConfirm={() => blocker.proceed?.()}
              onCancel={() => blocker.reset?.()}
            />
          ) : (
            <>
              {error && <WriteError message={error} onRetry={() => void onSave()} />}
              {blockedWhy && <Warning>{blockedWhy}</Warning>}
              {preview && preview.viewerLoses.length > 0 && !blockedWhy && (
                <Warning>
                  {t("settings.members.panel.youLose", {
                    missing: missingWords(preview.viewerLoses),
                    code,
                  })}
                </Warning>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <p className="num min-w-0 flex-1 text-sm text-ink">
                  {t("settings.members.panel.changes", { count: changes })}
                </p>
                <button type="button" className={quietButton} onClick={discard}>
                  {t("settings.members.panel.discard")}
                </button>
                <button
                  type="button"
                  className={`${primaryButton} disabled:opacity-40`}
                  disabled={saving || !preview || !!blockedWhy}
                  onClick={() => void onSave()}
                >
                  {t("settings.members.panel.save")}
                </button>
              </div>
            </>
          )}
        </SaveBar>
      )}
    </div>
  );
}

/** Una riga ▲ in `warning`: ciò che salvando succederebbe, o perché non si salva. */
function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-warning">
      <span className="mt-[3px] shrink-0">
        <TriangleGlyph size={12} />
      </span>
      <span className="min-w-0 text-pretty">{children}</span>
    </p>
  );
}

/** Una parte del pannello: titolo 14 px semibold, filetto sopra. */
function PanelPart({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-rule pt-4">
      <h3 id={id} className="mb-2 text-md font-semibold text-ink">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * «Remove from ACQ…»: conferma a due tempi in posto, poi la riconferma. Se
 * togliere la persona lascerebbe il progetto senza chi ne gestisce i membri,
 * il bottone è spento e la frase lo dice (`removeBlock`, dal livello dati).
 */
function RemoveFromProject({
  project,
  row,
  block,
  self,
  onRemoved,
}: {
  project: Project;
  row: MemberRow;
  block: string | null;
  self: boolean;
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const remove = useRemoveProjectMember();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const code = project.code;
  const name = row.name;
  const blockWords = (reason: string) =>
    reason === "last_members_manager"
      ? self
        ? t("settings.members.refusal.lastManagerSelfLeave", { code })
        : t("settings.members.refusal.lastManagerOther", { name, code })
      : reasonWords(t, reason, { name });

  async function onConfirm() {
    setAsking(false);
    setError(null);
    const result = await reauth(() => remove.mutateAsync([project.id, row.personId]), {
      action: t("settings.members.panel.removeAction", { name, code }),
    }).catch(() => null);
    if (result === null) return setError(t("settings.members.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "reauth_cancelled")
        return void toast.show(t("admin.refusal.reauthCancelled"));
      if (refusal.error === "invalid") return setError(blockWords(refusal.reason ?? ""));
      return setError(refusalWords(refusal, { name }));
    }
    toast.show(t("settings.members.panel.removed", { name, code }));
    onRemoved();
  }

  return (
    <div className="flex flex-col gap-2 border-t border-rule pt-4">
      {asking ? (
        <InlineConfirm
          message={t("settings.members.panel.removeAsk", { name, code })}
          confirm={t("settings.members.panel.removeConfirm")}
          cancelLabel={t("settings.members.panel.keep")}
          onConfirm={() => void onConfirm()}
          onCancel={() => {
            setAsking(false);
            window.setTimeout(() => button.current?.focus(), 0);
          }}
        />
      ) : (
        <button
          ref={button}
          type="button"
          disabled={block !== null}
          aria-describedby={block ? `${row.personId}-remove-why` : undefined}
          className={`${rowButton} -ml-2 w-fit text-critical! hover:bg-critical/10`}
          onClick={() => setAsking(true)}
        >
          {t("settings.members.panel.remove", { code })}
        </button>
      )}
      {block && (
        <p id={`${row.personId}-remove-why`} className="text-sm text-pretty text-ink-muted">
          {blockWords(block)}
        </p>
      )}
      {error && <WriteError message={error} />}
    </div>
  );
}
