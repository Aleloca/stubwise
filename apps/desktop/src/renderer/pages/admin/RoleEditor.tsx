import { useBlocker } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useRoles, useUpdateRole, type RoleView } from "../../data/queries";
import { useReauth } from "../../layout/useReauth";
import { inputClass } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { NotFound } from "../NotFound";
import { OpenCircleGlyph, TriangleGlyph } from "../preferences/glyphs";
import { ReadError, RowsSkeleton, WriteError, refusalOf } from "../preferences/parts";
import { InlineConfirm } from "../task/parts";
import { primaryButton, quietButton } from "../tasks/controls";
import { BackToPeople } from "./InvitePage";
import { PermissionTable } from "./PermissionTable";
import { HolderList, RoleMenu } from "./RolesPage";
import { SaveBar, useGiveBlock, useMissingWords, useRefusalWords, type UiRefusal } from "./parts";

// La pagina di un ruolo (shape admin-roles-members.md, «La pagina di un
// ruolo»): nome, le righe fisse su Claude [RM 2] e su «vedere l'attività
// delle persone» (R-E2), la tabella dei permessi del livello del ruolo, e la
// barra di salvataggio che dice prima quante persone cambiano e se chi salva
// perde qualcosa [RM 3]. Cosa è spento lo dice il livello dati
// (`notGivable`, `reach`); togliere un permesso non passa dall'escalation.

export function RoleEditor({ roleId }: { roleId: string }) {
  const { t } = useTranslation();
  const roles = useRoles();
  if (roles.isPending)
    return (
      <Frame>
        <span className="mt-4 block h-6 w-56 rounded-sm bg-ink/8" />
        <RowsSkeleton parts={2} />
      </Frame>
    );
  if (roles.isError)
    return (
      <Frame>
        <ReadError message={t("admin.role.loadError")} onRetry={() => void roles.refetch()} />
      </Frame>
    );
  const role = roles.data.find((r) => r.id === roleId);
  if (!role) return <NotFound />;
  // Rimontata quando il ruolo salvato cambia: la bozza riparte da lì.
  return <RoleBody key={`${role.id}:${role.name}:${role.permissions.join(",")}`} role={role} />;
}

/** La pagina (fino a 760 px) e, sotto, la barra di salvataggio larga quanto l'area. */
function Frame({ children, bar }: { children: ReactNode; bar?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col">
      <section className="page-header flex-1 pb-16 pl-8 [--page-header-pr:32px] [--page-header-pt:32px]">
        <div className="max-w-[760px]">
          <BackToPeople label={t("admin.role.back")} section="roles" />
          {children}
        </div>
      </section>
      {bar}
    </div>
  );
}

function RoleBody({ role }: { role: RoleView }) {
  const { t } = useTranslation();
  const update = useUpdateRole();
  const reauth = useReauth();
  const toast = useToast();
  const refusalWords = useRefusalWords();
  const missingWords = useMissingWords();
  const giveBlock = useGiveBlock();
  const [name, setName] = useState(role.name);
  const [perms, setPerms] = useState<Set<string>>(() => new Set(role.permissions));
  const [error, setError] = useState<string | null>(null);
  const [showWho, setShowWho] = useState(false);
  const nameId = useId();
  const saved = new Set(role.permissions);
  const added = [...perms].filter((p) => !saved.has(p));
  const removed = role.permissions.filter((p) => !perms.has(p));
  const nameChanged = name.trim() !== role.name;
  const changes = added.length + removed.length + (nameChanged ? 1 : 0);
  const dirty = changes > 0;
  const people = new Set(role.holders.map((h) => h.personId)).size;
  const notGivable = new Set(role.notGivable);

  // Lasciare la pagina con modifiche chiede prima; dopo un salvataggio o
  // un'eliminazione no.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: false,
    withResolver: true,
  });

  const toggle = (p: string) =>
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  const discard = () => {
    setName(role.name);
    setPerms(new Set(role.permissions));
    setError(null);
  };

  async function save() {
    setError(null);
    const patch = {
      ...(nameChanged ? { name } : {}),
      ...(added.length || removed.length ? { permissions: [...perms] } : {}),
    };
    const result = await reauth(() => update.mutateAsync([role.id, patch]), {
      action: t("admin.role.saveAction", { role: role.name }),
    }).catch(() => null);
    if (result === null) return setError(t("admin.role.saveFailed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) {
      // La riconferma chiusa: il dialogo ha già detto «Nothing was changed.», la bozza resta.
      if (refusal.error === "reauth_cancelled") return;
      if (refusal.error === "escalation")
        return setError(
          t(`admin.role.refusal.escalation.${role.reach}`, {
            missing: missingWords((refusal as { missing: string[] }).missing),
          }),
        );
      if (refusal.error === "invalid") return setError(roleInvalid(t, refusal.reason ?? ""));
      return setError(refusalWords(refusal));
    }
    // La pagina si rimonta sul ruolo salvato: la barra sparisce.
    dirtyRef.current = false;
    toast.show(t("admin.role.saved"));
  }

  const meta = [
    t(`admin.role.scope.${role.scope}`),
    role.preset ? t("admin.role.presetWord") : null,
    role.scope === "instance"
      ? t("admin.roles.people", { count: role.peopleCount })
      : t("admin.roles.memberships", { count: role.peopleCount }),
  ]
    .filter(Boolean)
    .join(" · ");

  const bar = dirty && (
    <SaveBar width={760}>
      {blocker.status === "blocked" ? (
        <InlineConfirm
          message={t("admin.role.leave", { count: changes })}
          confirm={t("admin.role.discard")}
          cancelLabel={t("admin.role.keep")}
          onConfirm={() => blocker.proceed?.()}
          onCancel={() => blocker.reset?.()}
        />
      ) : (
        <>
          {error && <WriteError message={error} onRetry={() => void save()} />}
          {role.viewerHolds && removed.length > 0 && (
            <p className="flex items-start gap-1.5 text-sm text-warning">
              <span className="mt-[3px] shrink-0">
                <TriangleGlyph size={12} />
              </span>
              {t("admin.role.youLose", { missing: missingWords(removed) })}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="num min-w-0 flex-1 text-sm text-ink">
              {t("admin.role.changes", { count: changes })}
              <span className="text-ink-muted">
                {" · "}
                {t("admin.role.affects", { count: people })}
              </span>
              {people > 0 && (
                <button
                  type="button"
                  aria-expanded={showWho}
                  onClick={() => setShowWho((s) => !s)}
                  className="ml-2 rounded-sm text-sm font-medium text-ink underline underline-offset-2 hover:text-ink-muted"
                >
                  {t("admin.role.who")}
                </button>
              )}
            </p>
            <button type="button" className={quietButton} onClick={discard}>
              {t("admin.role.discard")}
            </button>
            <button
              type="button"
              className={`${primaryButton} disabled:opacity-40`}
              disabled={update.isPending || !name.trim()}
              onClick={() => void save()}
            >
              {t("admin.role.save")}
            </button>
          </div>
          {showWho && (
            <div className="max-h-48 overflow-y-auto border-t border-rule pt-2">
              <HolderList role={role} />
            </div>
          )}
        </>
      )}
    </SaveBar>
  );

  return (
    <Frame bar={bar}>
      <header className="mt-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1
            title={role.name}
            className="truncate text-2xl font-semibold tracking-[-0.01em] text-ink"
          >
            {role.name}
          </h1>
          <p className="num mt-1 text-sm text-ink-muted">{meta}</p>
        </div>
        <RoleMenu role={role} afterDelete={() => (dirtyRef.current = false)} />
      </header>

      <div className="mt-6 flex max-w-[28rem] flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium text-ink">
          {t("admin.role.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
        />
        {role.preset && <p className="text-xs text-ink-muted">{t("admin.role.presetNote")}</p>}
      </div>

      <div className="mt-6 flex flex-col gap-1.5">
        <Note>{t("admin.role.claudeNote")}</Note>
        {role.scope === "project" && (
          <Note>
            {role.givesActivityView ? t("admin.role.activityYes") : t("admin.role.activityNo")}
          </Note>
        )}
      </div>

      <div className="mt-6 border-t border-rule pt-5">
        <h2 className="text-xl font-semibold text-ink">{t("admin.role.permissionsTitle")}</h2>
        <div className="mt-3">
          <PermissionTable
            scope={role.scope}
            label={t("admin.role.tableLabel", { role: role.name })}
            checked={perms}
            onToggle={toggle}
            // Spento solo ciò che si AGGIUNGEREBBE: togliere non passa dall'escalation.
            context={(p) =>
              notGivable.has(p) && !saved.has(p) ? giveBlock(role.reach, "role") : null
            }
          />
        </div>
      </div>
    </Frame>
  );
}

/** Una riga fissa in tono minore, col cerchio vuoto: si dice una volta. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-sm text-ink-muted">
      <span className="mt-[3px] shrink-0">
        <OpenCircleGlyph size={12} />
      </span>
      <span className="text-pretty">{children}</span>
    </p>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

/** I rifiuti `invalid` di un ruolo, in parole. */
function roleInvalid(t: T, reason: string): string {
  switch (reason) {
    case "name":
      return t("admin.roles.nameErrors.empty");
    case "name_taken":
      return t("admin.roles.nameErrors.taken");
    case "last_full_admin":
      return t("admin.role.refusal.lastFullAdmin");
    case "last_members_manager":
      return t("admin.role.refusal.lastMembersManager");
    default:
      return t("admin.refusal.status");
  }
}
