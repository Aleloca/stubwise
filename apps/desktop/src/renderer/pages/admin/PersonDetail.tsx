import { Link } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useAdminPerson,
  useLinkGitIdentity,
  useObservedAuthors,
  useReactivatePerson,
  useRoles,
  useSecurityEvents,
  useSetBitbucketUsername,
  useSetInstanceRole,
  useUnlinkGitIdentity,
  type PersonDetail as Person,
} from "../../data/queries";
import { can, useViewer } from "../../data/viewer";
import { useReauth } from "../../layout/useReauth";
import { inputClass } from "../../tasks-ui/Dialog";
import { Menu, itemClass } from "../../tasks-ui/Menu";
import { useToast } from "../../tasks-ui/Toast";
import { NotFound } from "../NotFound";
import { LogPart } from "../preferences/SecuritySection";
import { MoreGlyph, OpenCircleGlyph } from "../preferences/glyphs";
import {
  ArmedButton,
  Part,
  ReadError,
  Reveal,
  RowsSkeleton,
  WriteError,
  refusalOf,
  rowButton,
  rowClass,
} from "../preferences/parts";
import { Chevron, MenuButton, secondaryButton } from "../tasks/controls";
import { DeactivateDialog } from "./DeactivateDialog";
import { RoleOptions } from "./InviteDialog";
import { BackToPeople } from "./InvitePage";
import {
  AdminAvatar,
  DeptSwatch,
  reasonWords,
  usePermissionWords,
  useRefusalWords,
  useShortDate,
  useSourceWords,
  type UiRefusal,
} from "./parts";
import { ResetPasswordDialog, ResetSecondFactorDialog } from "./ResetDialogs";

// La pagina di una persona (shape admin-people.md, «La pagina di una
// persona», [PE 2]): testata con le azioni rare nel «⋯», poi le parti in
// una pagina che scorre — ruolo d'istanza, progetti, reparti, identità
// collegate, registro della sicurezza. Ogni azione c'è solo per chi la può
// fare, e i motivi delle scelte spente li dice il livello dati
// (`actions`, `instanceRoleChoices`): qui non si ricalcola nessuna regola.

type Dialog = "resetPassword" | "resetSecondFactor" | "deactivate" | null;

export function PersonDetail({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const person = useAdminPerson(personId);
  if (person.isPending)
    return (
      <Frame>
        <div className="mt-4 flex items-center gap-4">
          <span className="size-14 rounded-full bg-ink/8" />
          <span className="h-5 w-48 rounded-sm bg-ink/8" />
        </div>
        <RowsSkeleton parts={3} />
      </Frame>
    );
  if (person.isError) {
    // Claude, un id sconosciuto, un invito: come una persona che non c'è (R-G5).
    if ((person.error as Error).message === "not_found") return <NotFound />;
    return (
      <Frame>
        <ReadError
          message={t("admin.person.loadErrorGeneric")}
          onRetry={() => void person.refetch()}
        />
      </Frame>
    );
  }
  return <PersonBody person={person.data} />;
}

function Frame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <section className="page-header pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
      <div className="max-w-[760px]">
        <BackToPeople label={t("admin.person.back")} />
        {children}
      </div>
    </section>
  );
}

function PersonBody({ person }: { person: Person }) {
  const { t } = useTranslation();
  const date = useShortDate();
  const { viewer } = useViewer();
  const [dialog, setDialog] = useState<Dialog>(null);
  const more = useRef<HTMLButtonElement>(null);
  // `users.manage`: lo dice il livello dati (le identità non hanno il blocco «non su te stesso»).
  const manages = person.actions.identities === null;
  const off = person.status === "deactivated";
  const closeDialog = () => {
    setDialog(null);
    // Dopo un'azione dal «⋯» il fuoco torna al «⋯».
    window.setTimeout(() => more.current?.focus(), 0);
  };

  return (
    <Frame>
      <header className="mt-4 flex items-center gap-4">
        <AdminAvatar initials={person.avatar} size={56} muted={off} />
        <div className="min-w-0 flex-1">
          <h1
            title={person.name}
            className="truncate text-2xl font-semibold tracking-[-0.01em] text-ink"
          >
            {person.name}
          </h1>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-ink-muted">
            <span title={person.email} className="min-w-0 truncate">
              {person.email}
            </span>
            {off && person.deactivatedAt && (
              <span className="flex items-center gap-1">
                <span aria-hidden="true">·</span>
                <OpenCircleGlyph size={12} />
                {t("admin.person.deactivatedOn", { date: date(person.deactivatedAt) })}
              </span>
            )}
          </p>
        </div>
        {manages && !person.isSelf && (
          <MoreMenu person={person} buttonRef={more} onOpen={setDialog} />
        )}
      </header>
      {person.isSelf && <p className="mt-3 text-xs text-ink-muted">{t("admin.person.you")}</p>}
      <InstanceRolePart person={person} manages={manages} />
      <ProjectsPart person={person} />
      <DepartmentsPart person={person} />
      <IdentitiesPart person={person} manages={manages} />
      {manages && <SecurityLogPart personId={person.personId} />}
      {dialog === "resetPassword" && <ResetPasswordDialog person={person} onClose={closeDialog} />}
      {dialog === "resetSecondFactor" && (
        <ResetSecondFactorDialog
          person={person}
          peer={person.isFullAdmin && can(viewer, "instance.full_admin")}
          onClose={closeDialog}
        />
      )}
      {dialog === "deactivate" && (
        <DeactivateDialog person={person} onClose={closeDialog} onDone={closeDialog} />
      )}
    </Frame>
  );
}

/**
 * Il «⋯» delle azioni rare: ognuna c'è solo se si può fare su questa persona
 * (lo stato decide fra Deactivate e Reactivate); una spenta dice perché.
 * Reactivate ha la conferma a due tempi dentro il menu, senza riconferma.
 */
function MoreMenu({
  person,
  buttonRef,
  onOpen,
}: {
  person: Person;
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  onOpen: (d: Exclude<Dialog, null>) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const reactivate = useReactivatePerson();
  const refusalWords = useRefusalWords();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = person.name;
  const a = person.actions;
  const close = (restore: boolean) => {
    setOpen(false);
    setArmed(false);
    if (restore) buttonRef.current?.focus();
  };
  const pick = (d: Exclude<Dialog, null>) => {
    setOpen(false);
    onOpen(d);
  };

  async function onReactivate() {
    close(true);
    setError(null);
    const result = await reactivate.mutateAsync([person.personId]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name }));
    toast.show(t("admin.person.reactivated", { name }));
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1 self-start">
      <span className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("admin.person.more", { name })}
          onClick={() => setOpen((o) => !o)}
          className="grid size-8 place-items-center rounded-md text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink aria-expanded:bg-ink/10 aria-expanded:text-ink"
        >
          <MoreGlyph />
        </button>
        {open && (
          <Menu label={t("admin.person.more", { name })} onClose={close} align="right">
            {a.resetPassword === null && (
              <button type="button" role="menuitem" className={itemClass} onClick={() => pick("resetPassword")}>
                {t("admin.person.resetPassword")}
              </button>
            )}
            {a.resetSecondFactor !== "status" && (
              <button
                type="button"
                role="menuitem"
                aria-disabled={a.resetSecondFactor !== null || undefined}
                className={`${itemClass} ${a.resetSecondFactor !== null ? "cursor-default flex-col items-start gap-0 hover:bg-transparent" : ""}`}
                onClick={() => {
                  if (a.resetSecondFactor === null) pick("resetSecondFactor");
                }}
              >
                <span className={a.resetSecondFactor !== null ? "text-ink-muted" : undefined}>
                  {t("admin.person.resetSecondFactor")}
                </span>
                {a.resetSecondFactor !== null && (
                  <span className="text-xs text-ink-muted">
                    {reasonWords(t, a.resetSecondFactor, { name })}
                  </span>
                )}
              </button>
            )}
            {person.status === "active" ? (
              <button type="button" role="menuitem" className={itemClass} onClick={() => pick("deactivate")}>
                {t("admin.person.deactivate")}
              </button>
            ) : (
              a.reactivate === null && (
                <button
                  type="button"
                  role="menuitem"
                  className={`${itemClass} ${armed ? "text-critical" : ""}`}
                  onClick={() => (armed ? void onReactivate() : setArmed(true))}
                >
                  {armed ? t("admin.person.reactivateSure") : t("admin.person.reactivate")}
                </button>
              )
            )}
          </Menu>
        )}
      </span>
      {error && <WriteError message={error} />}
    </div>
  );
}

/** 1. Il ruolo d'istanza con la sua frase, e «Change…» per chi gestisce le persone. */
function InstanceRolePart({ person, manages }: { person: Person; manages: boolean }) {
  const { t } = useTranslation();
  const roles = useRoles().data ?? [];
  const setRole = useSetInstanceRole();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);
  const name = person.name;
  const current = person.instanceRole;
  const def = roles.find((r) => r.id === current?.id);
  const sentence = current
    ? t(
        `admin.person.instanceRole.sentence.${def?.preset && (def.key === "admin" || def.key === "user") ? def.key : "custom"}`,
        { role: current.name },
      )
    : t("admin.person.instanceRole.none");
  const block = person.actions.setInstanceRole;

  async function change(roleId: string) {
    setError(null);
    const role = person.instanceRoleChoices.find((r) => r.roleId === roleId);
    if (!role || roleId === current?.id) return;
    const result = await reauth(() => setRole.mutateAsync([person.personId, roleId]), {
      action: t("admin.person.instanceRole.reauthAction", { name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name, what: role.name }));
    toast.show(t("admin.person.instanceRole.changed", { name, role: role.name }));
  }

  return (
    <Part
      title={t("admin.person.instanceRole.title")}
      action={
        manages && (
          <MenuButton
            menuLabel={t("admin.person.instanceRole.menu", { name })}
            className={`${secondaryButton} h-7 px-2.5 disabled:opacity-40`}
            align="right"
            disabled={block !== null}
            label={
              <>
                {t("admin.person.instanceRole.change")}
                <Chevron />
              </>
            }
          >
            {(close) => (
              <RoleOptions
                roles={person.instanceRoleChoices}
                value={current?.id ?? ""}
                onPick={(roleId) => {
                  close();
                  void change(roleId);
                }}
              />
            )}
          </MenuButton>
        )
      }
    >
      <p className="text-md text-ink">{sentence}</p>
      {manages && block !== null && (
        <p className="mt-1 text-sm text-ink-muted">
          {reasonWords(t, block, { name, self: t("admin.person.instanceRole.selfBlocked") })}
        </p>
      )}
      {error && <WriteError message={error} />}
    </Part>
  );
}

/** 2. I progetti che chi guarda vede, col ruolo e i permessi in più con la loro fonte. */
function ProjectsPart({ person }: { person: Person }) {
  const { t } = useTranslation();
  const words = usePermissionWords();
  const source = useSourceWords();
  return (
    <Part title={t("admin.person.projects.title")}>
      {person.projects.length === 0 ? (
        <p className="text-md text-ink-muted">{t("admin.person.projects.empty")}</p>
      ) : (
        <ul>
          {person.projects.map((p) => (
            <li key={p.projectId} className="flex items-start gap-3 border-b border-rule py-2.5 last:border-b-0">
              <span className="num w-10 shrink-0 pt-0.5 text-xs font-semibold tracking-[0.02em] text-ink">
                {p.code}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <Link
                    to="/p/$code/$section"
                    params={{ code: p.code, section: "overview" }}
                    className="min-w-0 truncate text-md text-ink hover:underline hover:underline-offset-2"
                  >
                    {p.name}
                  </Link>
                  <span className="shrink-0 text-sm text-ink-muted">{p.role.name}</span>
                </div>
                {p.extra.map((x) => (
                  <p key={x.permission} className="text-sm text-ink-muted">
                    {t("admin.person.projects.extra", {
                      permission: words(x.permission),
                      source: x.sources.map(source).join(" · "),
                    })}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {person.alsoInHiddenProjects && (
        <p className="mt-2 text-xs text-ink-muted">{t("admin.person.projects.hidden")}</p>
      )}
    </Part>
  );
}

/** 3. I reparti, col campione del colore e la Home dove la gestisce. */
function DepartmentsPart({ person }: { person: Person }) {
  const { t } = useTranslation();
  return (
    <Part title={t("admin.person.departments.title")}>
      {person.departments.length === 0 ? (
        <p className="text-md text-ink-muted">{t("admin.person.departments.empty")}</p>
      ) : (
        <ul>
          {person.departments.map((d) => (
            <li key={d.id} className={rowClass}>
              <DeptSwatch colorToken={d.colorToken} />
              <span className="text-md text-ink">{d.name}</span>
              {d.managesHome && (
                <span className="text-sm text-ink-muted">
                  {t("admin.person.departments.managesHome")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Part>
  );
}

/** 4. Le email git (con gli autori osservati dell'Activity) e lo username Bitbucket. */
function IdentitiesPart({ person, manages }: { person: Person; manages: boolean }) {
  const { t } = useTranslation();
  const unlink = useUnlinkGitIdentity();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const name = person.name;
  const emails = person.identities.gitEmails;

  async function onUnlink(identity: string) {
    setError(null);
    const result = await reauth(() => unlink.mutateAsync([person.personId, identity]), {
      action: t("admin.person.identities.unlinkAction", { identity, name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name }));
    toast.show(t("admin.person.identities.unlinked", { identity, name }));
  }

  return (
    <Part title={t("admin.person.identities.title")}>
      <h3 className="text-sm font-semibold text-ink">{t("admin.person.identities.git")}</h3>
      {emails.length === 0 ? (
        <p className="mt-1 text-md text-ink-muted">{t("admin.person.identities.gitEmpty")}</p>
      ) : (
        <ul className="mt-1">
          {emails.map((identity) => (
            <li key={identity} className={rowClass}>
              <span className="min-w-0 flex-1 truncate text-md text-ink">{identity}</span>
              {manages && (
                <ArmedButton
                  label={t("admin.person.identities.unlink")}
                  sureLabel={t("admin.person.identities.unlinkSure")}
                  ariaLabel={t("admin.person.identities.unlinkLabel", { identity })}
                  onConfirm={() => void onUnlink(identity)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <WriteError message={error} />}
      {manages &&
        (linking ? (
          <Reveal>
            <LinkGitField
              person={person}
              onDone={() => {
                setLinking(false);
                window.setTimeout(() => linkButton.current?.focus(), 0);
              }}
            />
          </Reveal>
        ) : (
          <button
            ref={linkButton}
            type="button"
            className={`${rowButton} mt-1 -ml-2`}
            onClick={() => setLinking(true)}
          >
            {t("admin.person.identities.link")}
          </button>
        ))}
      <BitbucketRow person={person} manages={manages} />
    </Part>
  );
}

/**
 * «Link a git email»: la ricerca sugli autori osservati e non collegati (gli
 * stessi di «Link a person» dell'Activity, con commit, progetti e ultima
 * data), o un'email nuova scritta per intero.
 */
function LinkGitField({ person, onDone }: { person: Person; onDone: () => void }) {
  const { t } = useTranslation();
  const authors = useObservedAuthors();
  const link = useLinkGitIdentity();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const date = useShortDate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const listId = useId();
  const q = value.trim().toLowerCase();
  const matches = (authors.data ?? []).filter((a) => !q || a.name.toLowerCase().includes(q));
  const exact = matches.some((a) => a.name.toLowerCase() === q);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  async function onLink(identity: string) {
    setError(null);
    const result = await link.mutateAsync([person.personId, identity]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name: person.name }));
    toast.show(t("admin.person.identities.linked", { identity, name: person.name }));
    onDone();
  }

  const option =
    "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6";
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-rule p-3">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {t("admin.person.identities.linkLabel")}
      </label>
      <div className="flex gap-2">
        <input
          id={inputId}
          autoFocus
          value={value}
          aria-controls={listId}
          placeholder={t("admin.person.identities.linkPlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onDone();
            if (e.key === "Enter" && isEmail && !exact) void onLink(value.trim());
          }}
          className={inputClass}
        />
        <button type="button" className={rowButton} onClick={onDone}>
          {t("admin.person.identities.cancel")}
        </button>
      </div>
      <div id={listId} role="group" aria-label={t("admin.person.identities.observed")}>
        <p className="heading-group px-2 pt-1 pb-1">{t("admin.person.identities.observed")}</p>
        {matches.length === 0 && !isEmail ? (
          <p className="px-2 text-sm text-ink-muted">{t("admin.person.identities.noObserved")}</p>
        ) : (
          <ul className="flex max-h-56 flex-col overflow-y-auto">
            {matches.map((a) => (
              <li key={a.name}>
                <button type="button" className={option} onClick={() => void onLink(a.name)}>
                  <span className="text-md text-ink">{a.name}</span>
                  <span className="num text-xs text-ink-muted">
                    {t("admin.person.identities.authorLine", {
                      commits: t("projects.people.unlinkedCommits", { count: a.commits }),
                      projects: a.projectCodes.join(", "),
                      date: date(a.lastAt),
                    })}
                  </span>
                </button>
              </li>
            ))}
            {isEmail && !exact && (
              <li>
                <button type="button" className={option} onClick={() => void onLink(value.trim())}>
                  <span className="text-md text-ink">
                    {t("admin.person.identities.linkNew", { value: value.trim() })}
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
      {error && <WriteError message={error} />}
    </div>
  );
}

/** Lo username Bitbucket: il valore o «Not linked», con Link / Unlink. */
function BitbucketRow({ person, manages }: { person: Person; manages: boolean }) {
  const { t } = useTranslation();
  const set = useSetBitbucketUsername();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const current = person.identities.bitbucketUsername;

  async function save(next: string | null) {
    setError(null);
    const result = await set.mutateAsync([person.personId, next]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal, { name: person.name }));
    toast.show(
      t(next ? "admin.person.identities.bitbucketLinked" : "admin.person.identities.bitbucketUnlinked"),
    );
    setEditing(false);
    setValue("");
  }

  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-ink">{t("admin.person.identities.bitbucket")}</h3>
      {editing ? (
        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value.trim());
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t("admin.person.identities.bitbucketLabel")}
          </label>
          <input
            id={inputId}
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            className={`${inputClass} max-w-64`}
          />
          <button type="submit" className={secondaryButton} disabled={!value.trim() || set.isPending}>
            {t("admin.person.identities.bitbucketSave")}
          </button>
          <button type="button" className={rowButton} onClick={() => setEditing(false)}>
            {t("admin.person.identities.cancel")}
          </button>
        </form>
      ) : (
        <div className={rowClass}>
          <span className={`min-w-0 flex-1 truncate text-md ${current ? "text-ink" : "text-ink-muted"}`}>
            {current ?? t("admin.person.identities.notLinked")}
          </span>
          {manages &&
            (current ? (
              <ArmedButton
                label={t("admin.person.identities.unlink")}
                sureLabel={t("admin.person.identities.unlinkSure")}
                ariaLabel={t("admin.person.identities.unlinkLabel", { identity: current })}
                onConfirm={() => void save(null)}
              />
            ) : (
              <button type="button" className={rowButton} onClick={() => setEditing(true)}>
                {t("admin.person.identities.bitbucketLink")}
              </button>
            ))}
        </div>
      )}
      {error && <WriteError message={error} />}
    </div>
  );
}

/** 5. Il registro della sicurezza della persona (`users.manage`), come quello personale. */
function SecurityLogPart({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const events = useSecurityEvents(personId);
  if (events.isPending) return <RowsSkeleton parts={1} />;
  if (events.isError)
    return (
      <ReadError message={t("admin.person.securityLogError")} onRetry={() => void events.refetch()} />
    );
  return <LogPart events={events.data} />;
}
