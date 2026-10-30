import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useInvites, useRevokeInvite } from "../../data/queries";
import { can, useViewer } from "../../data/viewer";
import { useToast } from "../../tasks-ui/Toast";
import { NotFound } from "../NotFound";
import { ArmedButton, Part, ReadError, RowsSkeleton, WriteError, refusalOf } from "../preferences/parts";
import { TriangleGlyph } from "../preferences/glyphs";
import { secondaryButton } from "../tasks/controls";
import { useRefusalWords, useShortDate, type UiRefusal } from "./parts";

// La pagina di un invito (shape admin-people.md, «Inviti»): l'email come
// titolo, chi l'ha mandato e la scadenza, i progetti offerti col ruolo, il
// ruolo d'istanza, e «Revoke invite» con la conferma a due tempi. Il link non
// c'è: si è visto una volta, quando l'invito è stato creato.

export function InvitePage({ inviteId }: { inviteId: string }) {
  const { t } = useTranslation();
  const { viewer } = useViewer();
  const canInvite = can(viewer, "users.invite");
  const invites = useInvites(canInvite);
  const revoke = useRevokeInvite();
  const toast = useToast();
  const navigate = useNavigate();
  const date = useShortDate();
  const refusalWords = useRefusalWords();
  const [error, setError] = useState<string | null>(null);

  // Chi non invita non vede gli inviti (R-G5: come uno che non esiste).
  if (!canInvite) return <NotFound />;
  if (invites.isPending)
    return (
      <Frame>
        <RowsSkeleton parts={1} />
      </Frame>
    );
  if (invites.isError)
    return (
      <Frame>
        <ReadError message={t("admin.people.loadError")} onRetry={() => void invites.refetch()} />
      </Frame>
    );
  const invite = invites.data.find((i) => i.id === inviteId);
  // Un invito sconosciuto (o già accettato, o revocato) è come uno che non esiste (R-G5).
  if (!invite) return <NotFound />;

  async function onRevoke() {
    setError(null);
    const result = await revoke.mutateAsync([inviteId]).catch(() => null);
    if (result === null) return setError(t("admin.refusal.failed"));
    const refusal = refusalOf(result) as UiRefusal | null;
    if (refusal) return setError(refusalWords(refusal));
    toast.show(t("admin.invitePage.revoked"));
    void navigate({ to: "/admin/$section", params: { section: "people" } });
  }

  return (
    <Frame>
      <h1
        title={invite.email}
        className="mt-3 truncate text-2xl font-semibold tracking-[-0.01em] text-ink"
      >
        {invite.email}
      </h1>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-ink-muted">
        {invite.expired && (
          <span className="text-warning">
            <TriangleGlyph size={12} />
          </span>
        )}
        {t(invite.expired ? "admin.invitePage.sentExpired" : "admin.invitePage.sent", {
          name: invite.invitedByName,
          date: date(invite.createdAt),
          expires: date(invite.expiresAt),
        })}
      </p>
      <Part title={t("admin.invitePage.offered")}>
        {invite.projects.length === 0 ? (
          <p className="text-md text-ink-muted">{t("admin.invitePage.noProjects")}</p>
        ) : (
          <ul>
            {invite.projects.map((p) => (
              <li
                key={p.projectId}
                className="flex min-h-10 items-center gap-3 border-b border-rule last:border-b-0"
              >
                <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                  {p.code}
                </span>
                <span className="text-md text-ink">{p.roleName}</span>
              </li>
            ))}
          </ul>
        )}
      </Part>
      <Part title={t("admin.invitePage.instanceRole")}>
        <p className="text-md text-ink">{invite.instanceRole?.name ?? "—"}</p>
      </Part>
      <div className="mt-8 border-t border-rule pt-5">
        <ArmedButton
          label={t("admin.invitePage.revoke")}
          sureLabel={t("admin.invitePage.revokeSure")}
          className={secondaryButton}
          disabled={revoke.isPending}
          onConfirm={() => void onRevoke()}
        />
        {error && <WriteError message={error} />}
        <p className="mt-3 max-w-[62ch] text-xs text-ink-muted">{t("admin.invitePage.linkOnce")}</p>
      </div>
    </Frame>
  );
}

/** La cornice della pagina: «← People» sopra, fino a 760 px. */
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

/** «← People»: torna all'elenco (coi filtri dell'indirizzo di prima, se si arriva da lì). */
export function BackToPeople({ label }: { label: string }) {
  return (
    <Link
      to="/admin/$section"
      params={{ section: "people" }}
      className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm font-medium text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink"
    >
      <svg
        viewBox="0 0 16 16"
        width={14}
        height={14}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5" />
      </svg>
      {label}
    </Link>
  );
}
