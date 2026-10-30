import { useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  DEPARTMENT_COLORS,
  useAdminDepartments,
  useAdminPeople,
  useCreateDepartment,
  type DepartmentView,
} from "../../data/queries";
import { Dialog, inputClass } from "../../tasks-ui/Dialog";
import { PageError } from "../../tasks-ui/PageStates";
import { WriteError, refusalOf } from "../preferences/parts";
import { primaryButton, secondaryButton } from "../tasks/controls";
import { DeptSwatch, useMissingWords, useRefusalWords, type UiRefusal } from "./parts";

// Departments (shape admin-people.md, «Departments»): i reparti in righe da
// 48 px — campione, nome, quante persone, chi gestisce la Home, e in prosa i
// permessi che danno. Una riga apre il pannello del reparto
// (`?department=`, `DepartmentPanel`). La voce c'è solo con
// `departments.manage` (`adminSections`).

export function DepartmentsPage() {
  const { t } = useTranslation();
  const departments = useAdminDepartments();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { department?: string };
  const [creating, setCreating] = useState(false);
  const open = (id: string | undefined) =>
    void navigate({
      to: "/admin/$section",
      params: { section: "departments" },
      search: ((prev: Record<string, unknown>) => ({ ...prev, department: id })) as never,
    });

  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[960px]">
        <div className="flex items-center gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-[-0.01em] text-ink">
            {t("admin.sections.departments")}
          </h1>
          <button type="button" className={primaryButton} onClick={() => setCreating(true)}>
            {t("admin.departments.new")}
          </button>
        </div>
        <p className="mt-2 max-w-[62ch] text-md text-pretty text-ink-muted">
          {t("admin.departments.intro")}
        </p>
        <div className="mt-5 border-t border-rule">
          {departments.isPending ? (
            <DepartmentsSkeleton />
          ) : departments.isError ? (
            <PageError
              message={t("admin.departments.loadError")}
              onRetry={() => void departments.refetch()}
            />
          ) : departments.data.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-8">
              <p className="max-w-[56ch] text-md text-ink-muted">{t("admin.departments.empty")}</p>
              <button type="button" className={secondaryButton} onClick={() => setCreating(true)}>
                {t("admin.departments.new")}
              </button>
            </div>
          ) : (
            <DepartmentList
              rows={departments.data}
              selected={search.department}
              onOpen={(id) => open(id === search.department ? undefined : id)}
            />
          )}
        </div>
      </div>
      {creating && (
        <NewDepartmentDialog
          departments={departments.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            open(id);
          }}
        />
      )}
    </section>
  );
}

function DepartmentsSkeleton() {
  const { t } = useTranslation();
  const bar = "rounded-sm bg-ink/8";
  return (
    <div aria-busy="true" className="skeleton-breathe">
      <span role="status" className="sr-only">
        {t("taskUi.states.loading")}
      </span>
      {[34, 26, 40, 30, 22].map((w, i) => (
        <div key={i} className="flex h-12 items-center gap-3 border-b border-rule px-1">
          <span className="h-4 w-[3px] rounded-[1px] bg-ink/12" />
          <span className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} />
          <span className={`ml-auto h-2.5 w-24 ${bar}`} />
        </div>
      ))}
    </div>
  );
}

/** Le righe, con ↑/↓ fra l'una e l'altra; la riga aperta nel pannello è segnata. */
function DepartmentList({
  rows,
  selected,
  onOpen,
}: {
  rows: DepartmentView[];
  selected: string | undefined;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const people = useAdminPeople({ statuses: ["active", "deactivated"] }).data ?? [];
  const missingWords = useMissingWords();
  const nameOf = (id: string) => people.find((p) => p.personId === id)?.name ?? "";
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-dept-row]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = items[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <ul aria-label={t("admin.departments.listLabel")} onKeyDown={onKeyDown}>
      {rows.map((d) => {
        const home = d.homeManagerIds.map(nameOf).filter(Boolean);
        const open = d.id === selected;
        return (
          <li key={d.id} className="border-b border-rule">
            <button
              type="button"
              data-dept-row={d.id}
              aria-current={open || undefined}
              onClick={() => onOpen(d.id)}
              className={`flex min-h-12 w-full items-center gap-3 rounded-md px-1 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/4 ${open ? "bg-ink/10 hover:bg-ink/10" : ""}`}
            >
              <DeptSwatch colorToken={d.colorToken} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 truncate text-md font-medium text-ink">{d.name}</span>
                  <span className="num shrink-0 text-sm text-ink-muted">
                    {t("admin.departments.people", { count: d.memberIds.length })}
                  </span>
                  <span className="ml-auto min-w-0 truncate text-sm text-ink-muted">
                    {home.length > 0
                      ? t("admin.departments.home", { names: home.join(", ") })
                      : t("admin.departments.noHome")}
                  </span>
                </span>
                <span className="truncate text-sm text-ink-muted">
                  {d.projectPermissions.length > 0
                    ? t("admin.departments.gives", { permissions: missingWords(d.projectPermissions) })
                    : t("admin.departments.givesNothing")}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Il nome accessibile di una tinta: «Color 4, red-orange». */
export function useColorName() {
  const { t } = useTranslation();
  return (token: string) => {
    const n = DEPARTMENT_COLORS.indexOf(token as (typeof DEPARTMENT_COLORS)[number]) + 1;
    return t("admin.departments.color.name", { n, hue: t(`admin.departments.color.hues.${n}`) });
  };
}

/**
 * Le otto tinte come gruppo di scelta (`radiogroup`), ognuna col suo nome e,
 * sotto, «used by Sales» se già usata da un altro reparto (permesso, ma detto).
 */
export function ColorChoice({
  value,
  departments,
  self,
  onChange,
}: {
  value: string;
  departments: DepartmentView[];
  /** Il reparto che si sta cambiando: la sua tinta non è «usata da altri». */
  self?: string;
  onChange: (token: string) => void;
}) {
  const { t } = useTranslation();
  const colorName = useColorName();
  const labelId = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = DEPARTMENT_COLORS.indexOf(value as (typeof DEPARTMENT_COLORS)[number]);
    const next = DEPARTMENT_COLORS[(at + step + DEPARTMENT_COLORS.length) % DEPARTMENT_COLORS.length]!;
    onChange(next);
    const group = e.currentTarget;
    window.setTimeout(() => group.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus());
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-ink">
        {t("admin.departments.color.label")}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        className="grid grid-cols-4 gap-1.5"
      >
        {DEPARTMENT_COLORS.map((token) => {
          const usedBy = departments.filter((d) => d.colorToken === token && d.id !== self);
          const on = token === value;
          return (
            <button
              key={token}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={colorName(token)}
              tabIndex={on ? 0 : -1}
              data-color={token}
              title={colorName(token)}
              onClick={() => onChange(token)}
              className={`flex min-h-12 flex-col items-start justify-between gap-1 rounded-md border px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out ${on ? "border-ink bg-ink/6" : "border-rule hover:border-rule-strong hover:bg-ink/4"}`}
            >
              <span
                aria-hidden="true"
                className="block h-[3px] w-full rounded-[1px]"
                style={{ background: `var(${token})` }}
              />
              {usedBy.length > 0 && (
                // «used by» e, sotto, i nomi su una riga (interi nel `title`).
                <span
                  title={usedBy.map((d) => d.name).join(", ")}
                  className="flex w-full min-w-0 flex-col text-xs text-ink-muted"
                >
                  <span>{t("admin.departments.color.usedBy")}</span>
                  <span className="truncate">{usedBy.map((d) => d.name).join(", ")}</span>
                </span>
              )}
              {/* La scelta si dice anche a parole, non solo da fondo e bordo [R10]:
                  la tinta del reparto aperto e, nelle libere, il nome della tinta. */}
              {usedBy.length === 0 && (
                <span className="text-xs text-ink-faint">
                  {on && self
                    ? t("admin.departments.color.thisDepartment")
                    : t(`admin.departments.color.hues.${token.replace("--dept-", "")}`)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** «New department»: nome e colore (la prima tinta libera già scelta), poi il suo pannello. */
function NewDepartmentDialog({
  departments,
  onClose,
  onCreated,
}: {
  departments: DepartmentView[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateDepartment();
  const refusalWords = useRefusalWords();
  const firstFree =
    DEPARTMENT_COLORS.find((c) => !departments.some((d) => d.colorToken === c)) ??
    DEPARTMENT_COLORS[0]!;
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(firstFree);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  async function onCreate() {
    setError(null);
    const result = await create.mutateAsync([{ name, colorToken: color }]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      if (refusal.error === "invalid") return setError(departmentInvalid(t, refusal.reason ?? ""));
      return setError(refusalWords(refusal));
    }
    onCreated((result as { departmentId: string }).departmentId);
  }

  return (
    <Dialog
      title={t("admin.departments.new")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("admin.departments.cancel")}
          </button>
          <button
            type="button"
            className={`${primaryButton} disabled:opacity-40`}
            disabled={!name.trim() || create.isPending}
            onClick={() => void onCreate()}
          >
            {t("admin.departments.create")}
          </button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onCreate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium text-ink">
            {t("admin.departments.name")}
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </div>
        <ColorChoice value={color} departments={departments} onChange={setColor} />
        {error && <WriteError message={error} />}
      </form>
    </Dialog>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

/** I rifiuti `invalid` di un reparto, in parole. */
export function departmentInvalid(t: T, reason: string): string {
  switch (reason) {
    case "name":
      return t("admin.departments.errors.name");
    case "name_taken":
      return t("admin.departments.errors.nameTaken");
    case "last_members_manager":
      return t("admin.role.refusal.lastMembersManager");
    case "last_full_admin":
      return t("admin.role.refusal.lastFullAdmin");
    default:
      return t("admin.refusal.status");
  }
}
