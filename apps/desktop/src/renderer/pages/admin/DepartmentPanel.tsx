import { useBlocker, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { canSeeAdminSection } from "../../data/adminSections";
import {
  useAdminDepartments,
  useAdminPeople,
  useDeleteDepartment,
  useSetDepartmentMembers,
  useSetDepartmentPermissions,
  useSetHomeManagers,
  useSessionPersonId,
  useUpdateDepartment,
  type DepartmentView,
  type PersonRow,
} from "../../data/queries";
import { useViewer } from "../../data/viewer";
import { DOCKED_PANEL_QUERY, DetailPanel } from "../../layout/useDetailPanel";
import { useMediaQuery } from "../../layout/useMediaQuery";
import { useReauth } from "../../layout/useReauth";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { CheckBox, RadioDot, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { Reveal, WriteError, refusalOf, rowButton } from "../preferences/parts";
import { CloseIcon, InlineConfirm } from "../task/parts";
import { Chevron, MenuButton, dangerSolidButton, primaryButton, quietButton, secondaryButton } from "../tasks/controls";
import { ColorChoice, departmentInvalid } from "./DepartmentsPage";
import { PermissionTable } from "./PermissionTable";
import {
  AdminAvatar,
  DeptSwatch,
  SaveBar,
  useGiveBlock,
  useMissingWords,
  useRefusalWords,
  type UiRefusal,
} from "./parts";

// Il pannello di un reparto (shape admin-people.md, «Departments», [PE 7]):
// nome e colore si salvano subito; persone, Home e permessi in una bozza che
// si salva insieme dalla barra in fondo («3 changes · Save · Discard»), con
// una riconferma. Chiudere il pannello (o lasciare la pagina, o aprire un
// altro reparto) con modifiche chiede prima. Cosa è spento lo dice il
// livello dati: `missingToAdd` per le persone, `notGivable`/`reach` per i
// permessi. Claude non è fra le persone (non sta negli accessi).

/**
 * L'host del pannello (`/admin/departments?department=<id>`), montato
 * nell'`AppLayout` accanto alla pagina: affiancato da 1200 px, sovrapposto
 * sotto. Cambiare persona lo chiude: niente del reparto resta a schermo.
 */
export function DepartmentPanelHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { viewer } = useViewer();
  const search = useSearch({ strict: false }) as { department?: string };
  const onPage = useRouterState({
    select: (s) => s.location.pathname === "/admin/departments",
  });
  const wide = useMediaQuery(DOCKED_PANEL_QUERY);
  const personId = useSessionPersonId();
  const allowed = onPage && canSeeAdminSection(viewer, "departments");
  const departments = useAdminDepartments(allowed && !!search.department);
  const close = useCallback(() => {
    void navigate({
      to: "/admin/$section",
      params: { section: "departments" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, department: undefined })) as never,
    });
  }, [navigate]);
  const [viewerId, setViewerId] = useState(personId);
  useEffect(() => {
    if (viewerId !== personId) {
      setViewerId(personId);
      if (search.department) close();
    }
  }, [viewerId, personId, search.department, close]);
  // Un `?department=` che non c'è (eliminato, inventato) chiude il pannello in silenzio.
  const unknown =
    departments.data !== undefined && !departments.data.some((d) => d.id === search.department);
  useEffect(() => {
    if (allowed && search.department && unknown) close();
  }, [allowed, search.department, unknown, close]);
  if (!allowed || !search.department || viewerId !== personId) return null;
  const department = departments.data?.find((d) => d.id === search.department);
  if (!department) return null;
  return (
    <DetailPanel
      mode={wide ? "docked" : "overlay"}
      label={t("admin.department.panelLabel", { name: department.name })}
      onClose={close}
    >
      <DepartmentPanel
        key={department.id}
        department={department}
        all={departments.data ?? []}
        onClose={close}
      />
    </DetailPanel>
  );
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));
const diff = (a: readonly string[], b: readonly string[]) => a.filter((x) => !b.includes(x));

export function DepartmentPanel({
  department: d,
  all,
  onClose,
}: {
  department: DepartmentView;
  all: DepartmentView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reauth = useReauth();
  const refusalWords = useRefusalWords();
  const missingWords = useMissingWords();
  const giveBlock = useGiveBlock();
  const setMembers = useSetDepartmentMembers();
  const setHome = useSetHomeManagers();
  const setPerms = useSetDepartmentPermissions();
  const people = useAdminPeople({ statuses: ["active", "deactivated"] }).data ?? [];
  const [members, setMembersDraft] = useState<string[]>(d.memberIds);
  const [home, setHomeDraft] = useState<string[]>(d.homeManagerIds);
  const [perms, setPermsDraft] = useState<Set<string>>(() => new Set(d.projectPermissions));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);

  const permList = [...perms];
  const changes =
    diff(members, d.memberIds).length +
    diff(d.memberIds, members).length +
    diff(home, d.homeManagerIds).length +
    diff(d.homeManagerIds, home).length +
    diff(permList, d.projectPermissions).length +
    diff(d.projectPermissions, permList).length;
  const dirty = changes > 0;

  // Chiudere, aprire un altro reparto o lasciare la pagina con modifiche chiede prima.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirtyRef.current &&
      (next.pathname !== current.pathname ||
        (next.search as { department?: string }).department !== d.id),
    enableBeforeUnload: false,
    withResolver: true,
  });

  const person = (id: string): PersonRow | undefined => people.find((p) => p.personId === id);
  const nameOf = (id: string) => person(id)?.name ?? "";

  const toggleHome = (id: string) =>
    setHomeDraft((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  const remove = (id: string) => {
    setMembersDraft((m) => m.filter((x) => x !== id));
    setHomeDraft((h) => h.filter((x) => x !== id));
  };
  const add = (id: string) => setMembersDraft((m) => (m.includes(id) ? m : [...m, id]));
  const togglePerm = (p: string) =>
    setPermsDraft((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const discard = () => {
    setMembersDraft(d.memberIds);
    setHomeDraft(d.homeManagerIds);
    setPermsDraft(new Set(d.projectPermissions));
    setError(null);
  };

  /**
   * Le scritture, una dopo l'altra (la riconferma vale per tutte): prima i
   * permessi tolti, poi le persone, poi i permessi aggiunti, poi la Home.
   * Così chi entra non riceve un permesso che si sta togliendo, e un
   * permesso nuovo si controlla sulle persone che resteranno.
   */
  async function save() {
    setError(null);
    setSaving(true);
    const added = diff(permList, d.projectPermissions);
    const removed = diff(d.projectPermissions, permList);
    const steps: { run: () => Promise<unknown>; kind: "perms" | "members" | "home" }[] = [];
    if (removed.length > 0)
      steps.push({
        kind: "perms",
        run: () => setPerms.mutateAsync([d.id, d.projectPermissions.filter((p) => perms.has(p))]),
      });
    if (!same(members, d.memberIds))
      steps.push({ kind: "members", run: () => setMembers.mutateAsync([d.id, members]) });
    if (added.length > 0)
      steps.push({ kind: "perms", run: () => setPerms.mutateAsync([d.id, permList]) });
    if (!same(home, d.homeManagerIds))
      steps.push({ kind: "home", run: () => setHome.mutateAsync([d.id, home]) });
    for (const step of steps) {
      const result = await reauth(step.run, {
        action: t("admin.department.saveAction", { name: d.name }),
      }).catch(() => null);
      if (result === null) {
        setSaving(false);
        return setError(t("admin.department.saveFailed"));
      }
      const refusal = refusalOf(result) as UiRefusal | null;
      if (refusal) {
        setSaving(false);
        if (refusal.error === "reauth_cancelled") return;
        if (refusal.error === "escalation") {
          const missing = missingWords((refusal as { missing: string[] }).missing);
          return setError(
            step.kind === "members"
              ? t("admin.department.refusal.addPeople", { name: d.name, missing })
              : t(`admin.department.refusal.permissions.${d.reach}`, { missing }),
          );
        }
        if (refusal.error === "invalid") return setError(departmentInvalid(t, refusal.reason ?? ""));
        return setError(refusalWords(refusal));
      }
    }
    setSaving(false);
    dirtyRef.current = false;
    toast.show(t("admin.department.saved"));
  }

  const notGivable = new Set(d.notGivable);
  const savedPerms = new Set(d.projectPermissions);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col gap-6 px-5 pt-4 pb-6">
        <header className="flex items-center gap-2.5">
          <DeptSwatch colorToken={d.colorToken} height={20} />
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">{d.name}</h2>
          <button
            type="button"
            aria-label={t("admin.department.close")}
            onClick={onClose}
            className="grid size-7 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
          >
            <CloseIcon />
          </button>
        </header>

        <NameAndColor department={d} all={all} />

        <PanelPart title={t("admin.department.people.title")} count={members.length}>
          {members.length === 0 ? (
            <p className="text-sm text-ink-muted">{t("admin.department.people.empty")}</p>
          ) : (
            <ul aria-label={t("admin.department.people.listLabel", { name: d.name })}>
              {[...members]
                .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
                .map((id) => {
                  const p = person(id);
                  const off = p?.status === "deactivated";
                  return (
                    <li
                      key={id}
                      className="flex min-h-10 items-center gap-2.5 border-b border-rule py-1 last:border-b-0"
                    >
                      <AdminAvatar initials={p?.avatar ?? ""} muted={off} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={`truncate text-md ${off ? "text-ink-muted" : "text-ink"}`}>
                          {nameOf(id)}
                        </span>
                        <label className="relative flex w-fit items-center gap-1.5 rounded-sm text-xs text-ink-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={home.includes(id)}
                            onChange={() => toggleHome(id)}
                            aria-label={t("admin.department.people.managesHomeOf", {
                              name: nameOf(id),
                            })}
                          />
                          <CheckBox checked={home.includes(id)} />
                          <span aria-hidden="true">{t("admin.department.people.managesHome")}</span>
                        </label>
                      </span>
                      <button
                        type="button"
                        className={rowButton}
                        aria-label={t("admin.department.people.removeLabel", { name: nameOf(id) })}
                        onClick={() => remove(id)}
                      >
                        {t("admin.department.people.remove")}
                      </button>
                    </li>
                  );
                })}
            </ul>
          )}
          <AddPeople
            department={d}
            members={members}
            people={people}
            onAdd={add}
          />
        </PanelPart>

        <PanelPart title={t("admin.department.permissions.title")}>
          <p className="mb-3 text-sm text-pretty text-ink-muted">
            {t("admin.department.permissions.intro")}
          </p>
          <PermissionTable
            scope="project"
            label={t("admin.department.permissions.tableLabel", { name: d.name })}
            checked={perms}
            onToggle={togglePerm}
            context={(p) =>
              notGivable.has(p) && !savedPerms.has(p) ? giveBlock(d.reach, "department") : null
            }
          />
        </PanelPart>

        <div className="border-t border-rule pt-4">
          <button
            ref={deleteButton}
            type="button"
            className={`${rowButton} -ml-2 text-critical! hover:bg-critical/10`}
            onClick={() => setDeleting(true)}
          >
            {t("admin.department.delete")}
          </button>
        </div>
      </div>

      {(dirty || blocker.status === "blocked") && (
        <SaveBar inset="px-5">
          {blocker.status === "blocked" ? (
            <InlineConfirm
              message={t("admin.department.discardAsk", { count: changes })}
              confirm={t("admin.department.discard")}
              cancelLabel={t("admin.department.keep")}
              onConfirm={() => blocker.proceed?.()}
              onCancel={() => blocker.reset?.()}
            />
          ) : (
            <>
              {error && <WriteError message={error} onRetry={() => void save()} />}
              <div className="flex flex-wrap items-center gap-2">
                <p className="num min-w-0 flex-1 text-sm text-ink">
                  {t("admin.department.changes", { count: changes })}
                </p>
                <button type="button" className={quietButton} onClick={discard}>
                  {t("admin.department.discard")}
                </button>
                <button
                  type="button"
                  className={`${primaryButton} disabled:opacity-40`}
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {t("admin.department.save")}
                </button>
              </div>
            </>
          )}
        </SaveBar>
      )}

      {deleting && (
        <DeleteDepartmentDialog
          department={d}
          all={all}
          onClose={() => {
            setDeleting(false);
            window.setTimeout(() => deleteButton.current?.focus(), 0);
          }}
          onDeleted={() => {
            dirtyRef.current = false;
            onClose();
          }}
        />
      )}
    </div>
  );
}

/** Una parte del pannello: titolo 14 px semibold, il numero accanto, filetto sopra. */
function PanelPart({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-rule pt-4">
      <h3 id={id} className="mb-2 flex items-baseline gap-2 text-md font-semibold text-ink">
        {title}
        {count !== undefined && <span className="num text-sm font-normal text-ink-faint">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Nome e colore: si salvano subito (`updateDepartment`, nessuna riconferma). */
function NameAndColor({ department: d, all }: { department: DepartmentView; all: DepartmentView[] }) {
  const { t } = useTranslation();
  const update = useUpdateDepartment();
  const refusalWords = useRefusalWords();
  const [name, setName] = useState(d.name);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  // Il nome salvato cambiato da fuori (un altro salvataggio) riporta il campo.
  useEffect(() => setName(d.name), [d.name]);

  async function patch(p: { name?: string; colorToken?: string }) {
    setError(null);
    const result = await update.mutateAsync([d.id, p]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (p.name !== undefined) setName(d.name);
      return setError(
        refusal.error === "invalid"
          ? departmentInvalid(t, refusal.reason ?? "")
          : refusalWords(refusal),
      );
    }
  }
  const commitName = () => {
    if (name.trim() && name.trim() !== d.name) void patch({ name });
    else setName(d.name);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-ink">
          {t("admin.departments.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName();
            if (e.key === "Escape" && name !== d.name) {
              e.preventDefault();
              setName(d.name);
            }
          }}
          className={inputClass}
        />
      </div>
      <ColorChoice
        value={d.colorToken}
        departments={all}
        self={d.id}
        onChange={(token) => {
          if (token !== d.colorToken) void patch({ colorToken: token });
        }}
      />
      {error && <WriteError message={error} />}
    </div>
  );
}

/**
 * «Add people»: la ricerca fra le persone attive non ancora nel reparto. Chi
 * riceverebbe permessi che chi agisce non ha nei suoi progetti è spento col
 * motivo (`missingToAdd`).
 */
function AddPeople({
  department: d,
  members,
  people,
  onAdd,
}: {
  department: DepartmentView;
  members: string[];
  people: PersonRow[];
  onAdd: (id: string) => void;
}) {
  const { t } = useTranslation();
  const missingWords = useMissingWords();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputId = useId();
  const button = useRef<HTMLButtonElement>(null);
  // Le persone che il livello dati offre, più chi è stato tolto nella bozza (rimetterlo non cambia niente).
  const offered = [
    ...Object.keys(d.missingToAdd),
    ...d.memberIds.filter((id) => !members.includes(id)),
  ];
  const needle = q.trim().toLowerCase();
  const rows = people
    .filter((p) => offered.includes(p.personId) && !members.includes(p.personId))
    .filter((p) => !needle || `${p.name} ${p.email}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  const close = () => {
    setOpen(false);
    setQ("");
    window.setTimeout(() => button.current?.focus(), 0);
  };

  if (!open)
    return (
      <button
        ref={button}
        type="button"
        className={`${rowButton} mt-1 -ml-2`}
        onClick={() => setOpen(true)}
      >
        {t("admin.department.people.add")}
      </button>
    );
  return (
    <Reveal>
      <div className="mt-2 flex flex-col gap-2 rounded-md border border-rule p-2.5">
        <label htmlFor={inputId} className="sr-only">
          {t("admin.department.people.findLabel")}
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            autoFocus
            type="search"
            value={q}
            placeholder={t("admin.department.people.find")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            className={`${inputClass} h-7 py-0 text-sm`}
          />
          <button type="button" className={rowButton} onClick={close}>
            {t("admin.department.people.done")}
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="px-1 text-sm text-ink-muted">{t("admin.department.people.noOne")}</p>
        ) : (
          <ul
            aria-label={t("admin.department.people.candidates")}
            className="flex max-h-56 flex-col overflow-y-auto"
          >
            {rows.map((p) => {
              const missing = d.missingToAdd[p.personId] ?? [];
              const blocked = missing.length > 0;
              return (
                <li key={p.personId}>
                  <button
                    type="button"
                    aria-disabled={blocked || undefined}
                    onClick={() => {
                      if (!blocked) onAdd(p.personId);
                    }}
                    className={`flex w-full min-w-0 items-start gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out ${blocked ? "cursor-default" : "hover:bg-ink/6"}`}
                  >
                    <AdminAvatar initials={p.avatar} muted={blocked} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-md ${blocked ? "text-ink-muted" : "text-ink"}`}>
                        {p.name}
                      </span>
                      <span className="text-xs text-pretty text-ink-muted">
                        {blocked
                          ? t("admin.department.people.cantAdd", {
                              name: d.name,
                              missing: missingWords(missing),
                            })
                          : p.email}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Reveal>
  );
}

/**
 * «Delete department…»: senza task, la conferma; con task, dove spostarle
 * (un altro reparto: una task ha sempre un reparto). Nessuna riconferma
 * (`deleteDepartment` non la chiede).
 */
function DeleteDepartmentDialog({
  department: d,
  all,
  onClose,
  onDeleted,
}: {
  department: DepartmentView;
  all: DepartmentView[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const del = useDeleteDepartment();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const others = all.filter((x) => x.id !== d.id);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const withTasks = d.taskCount > 0;
  const targetDept = others.find((x) => x.id === target);

  async function onDelete() {
    setError(null);
    const result = await del.mutateAsync([d.id, withTasks ? target : null]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "invalid") return setError(departmentInvalid(t, refusal.reason ?? ""));
      return setError(refusalWords(refusal));
    }
    const moved = (result as { moved: number }).moved;
    toast.show(
      moved > 0 && targetDept
        ? t("admin.department.deletedMoved", { name: d.name, count: moved, to: targetDept.name })
        : t("admin.department.deleted", { name: d.name }),
    );
    onDeleted();
  }

  return (
    <Dialog
      title={t("admin.department.deleteTitle", { name: d.name })}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.departments.cancel")}
          </button>
          <button
            type="button"
            className={dangerSolidButton}
            disabled={(withTasks && !target) || del.isPending}
            onClick={() => void onDelete()}
          >
            {withTasks ? t("admin.department.moveAndDelete") : t("admin.department.deleteConfirm")}
          </button>
        </>
      }
    >
      {withTasks ? (
        <div className="flex flex-col gap-2">
          <p className="text-md text-ink">
            {t("admin.department.tasksMove", { count: d.taskCount, name: d.name })}
          </p>
          <MenuButton
            menuLabel={t("admin.department.moveTo")}
            className={`${secondaryButton} justify-between`}
            wrapperClassName="flex"
            label={
              <>
                <span className="flex min-w-0 items-center gap-2">
                  {targetDept && <DeptSwatch colorToken={targetDept.colorToken} height={12} />}
                  <span className="truncate">
                    {targetDept?.name ?? t("admin.department.pickDepartment")}
                  </span>
                </span>
                <Chevron />
              </>
            }
          >
            {(close) =>
              others.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={x.id === target}
                  tabIndex={-1}
                  className={itemClass}
                  onClick={() => {
                    setTarget(x.id);
                    close();
                  }}
                >
                  <RadioDot checked={x.id === target} />
                  <DeptSwatch colorToken={x.colorToken} height={12} />
                  <span className="min-w-0 truncate">{x.name}</span>
                </button>
              ))
            }
          </MenuButton>
          <p className="text-sm text-ink-muted">{t("admin.department.peopleStay", { name: d.name })}</p>
        </div>
      ) : (
        <p className="text-md text-ink">{t("admin.department.deleteBody", { name: d.name })}</p>
      )}
      {error && <WriteError message={error} />}
    </Dialog>
  );
}
