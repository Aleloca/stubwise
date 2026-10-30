import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useInvite, useRegister, type InviteLookup } from "../../data/queries";
import { formatDate } from "../../notifications/time";
import { useToast } from "../../tasks-ui/Toast";
import { primaryButton } from "../tasks/controls";
import { BusyLabel, EntryColumn, EntryField, EntryHeading, ErrorLine, textButton } from "./parts";

/** Fino a tanti progetti offerti in elenco; oltre, i primi 6 e «and N more». */
const ALL_UNTIL = 8;
const FIRST = 6;
const MIN_PASSWORD = 8;

/**
 * `/register/$token` (shape `entry.md`): chi invita, i progetti offerti col
 * ruolo, e il modulo; scaduto, revocato o sconosciuto lo dicono in parole,
 * mai un 404. Un link inventato non rivela niente (la stessa pagina di uno
 * già usato).
 */
export function RegisterPage({ token }: { token: string }) {
  const { t } = useTranslation();
  const invite = useInvite(token);
  return (
    <EntryColumn>
      {invite.isPending ? (
        <div aria-busy="true" aria-label={t("entry.register.loading")} className="mb-6">
          <div className="h-8 w-56 animate-pulse rounded-md bg-ink/8 motion-reduce:animate-none" />
          <div className="mt-3 h-4 w-72 animate-pulse rounded-md bg-ink/6 motion-reduce:animate-none" />
        </div>
      ) : invite.isError ? (
        <>
          <EntryHeading title={t("entry.register.title")} />
          <ErrorLine
            action={
              <button
                type="button"
                className={`${textButton} ml-1`}
                onClick={() => void invite.refetch()}
              >
                {t("taskUi.states.retry")}
              </button>
            }
          >
            {t("entry.register.loadFailed")}
          </ErrorLine>
        </>
      ) : invite.data.status === "valid" ? (
        <ValidInvite token={token} invite={invite.data} />
      ) : (
        <NotValid invite={invite.data} />
      )}
    </EntryColumn>
  );
}

function NotValid({ invite }: { invite: Exclude<InviteLookup, { status: "valid" }> }) {
  const { t, i18n } = useTranslation();
  const first = (name: string) => name.split(" ")[0] ?? name;
  const [title, body] =
    invite.status === "expired"
      ? [
          t("entry.register.expiredTitle"),
          t("entry.register.expiredBody", {
            name: invite.invitedByName,
            first: first(invite.invitedByName),
            invited: formatDate(invite.invitedAt, i18n.language),
            expired: formatDate(invite.expiresAt, i18n.language),
          }),
        ]
      : invite.status === "revoked"
        ? [
            t("entry.register.revokedTitle"),
            t("entry.register.revokedBody", { name: invite.invitedByName }),
          ]
        : [t("entry.register.revokedTitle"), t("entry.register.invalidBody")];
  return (
    <section data-invite-status={invite.status}>
      <EntryHeading title={title} lead={body} />
      <Link to="/login" className={`${textButton} text-sm`}>
        {t("entry.register.goToSignIn")}
      </Link>
    </section>
  );
}

function ValidInvite({
  token,
  invite,
}: {
  token: string;
  invite: Extract<InviteLookup, { status: "valid" }>;
}) {
  const { t, i18n } = useTranslation();
  const register = useRegister();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [tried, setTried] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [allProjects, setAllProjects] = useState(false);

  const nameError = tried && !name.trim() ? t("entry.register.nameMissing") : null;
  const passwordError =
    tried && password.length < MIN_PASSWORD ? t("entry.register.tooShort") : null;
  const confirmError =
    tried && !passwordError && confirm !== password ? t("entry.register.mismatch") : null;

  const projects = invite.projects;
  const shown = allProjects || projects.length <= ALL_UNTIL ? projects : projects.slice(0, FIRST);

  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    setRefused(null);
    if (!name.trim() || password.length < MIN_PASSWORD || confirm !== password) return;
    register.mutate(
      { token, email: invite.email, name: name.trim(), password },
      {
        onSuccess: (r) => {
          if (!r.ok) {
            // L'invito è cambiato nel frattempo (scaduto, revocato, usato).
            setRefused(
              r.error === "invalid_input" && r.reason === "password"
                ? t("entry.register.tooShort")
                : t("entry.register.noLonger"),
            );
            return;
          }
          void navigate({ to: "/home", replace: true });
          const codes = projects.map((p) => p.code);
          toast.show(
            codes.length
              ? t("entry.register.welcome", {
                  name: name.trim().split(" ")[0],
                  projects: new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(
                    codes,
                  ),
                })
              : t("entry.register.welcomeNoProjects", { name: name.trim().split(" ")[0] }),
          );
        },
      },
    );
  }

  return (
    <>
      <EntryHeading
        title={t("entry.register.title")}
        lead={t("entry.register.invitedBy", { name: invite.invitedByName })}
      />
      {(projects.length > 0 || invite.instanceRoleName) && (
        <section aria-labelledby="invite-gets" className="mb-6 flex flex-col gap-2">
          <h2 id="invite-gets" className="heading-group">
            {t("entry.register.whatYouGet")}
          </h2>
          <ul className="flex flex-col border-y border-rule">
            {shown.map((p) => (
              <li
                key={p.projectId}
                className="flex h-9 items-center gap-3 border-b border-rule text-sm last:border-b-0"
              >
                <span className="num w-10 shrink-0 text-xs font-semibold tracking-[0.02em] text-ink">
                  {p.code}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink" title={p.name}>
                  {p.name}
                </span>
                <span className="shrink-0 text-ink-muted">{p.roleName}</span>
              </li>
            ))}
            {shown.length < projects.length && (
              <li className="flex h-9 items-center">
                <button
                  type="button"
                  className={`${textButton} text-sm`}
                  onClick={() => setAllProjects(true)}
                >
                  {t("entry.register.more", { count: projects.length - shown.length })}
                </button>
              </li>
            )}
            {invite.instanceRoleName && (
              <li className="flex h-9 items-center text-sm text-ink">
                {t("entry.register.instanceRole", { role: invite.instanceRoleName })}
              </li>
            )}
          </ul>
        </section>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <EntryField
          label={t("entry.register.email")}
          type="email"
          value={invite.email}
          readOnly
          hint={t("entry.register.emailHint")}
        />
        <EntryField
          label={t("entry.register.name")}
          autoComplete="name"
          autoFocus
          value={name}
          error={nameError}
          onChange={(e) => setName(e.target.value)}
        />
        <EntryField
          label={t("entry.register.password")}
          type="password"
          autoComplete="new-password"
          value={password}
          error={passwordError}
          onChange={(e) => setPassword(e.target.value)}
        />
        <EntryField
          label={t("entry.register.confirm")}
          type="password"
          autoComplete="new-password"
          value={confirm}
          error={confirmError}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {refused && <ErrorLine>{refused}</ErrorLine>}
        {register.isError && <ErrorLine>{t("entry.register.createFailed")}</ErrorLine>}
        <div className="flex justify-end">
          <button type="submit" className={primaryButton} aria-busy={register.isPending}>
            <BusyLabel
              busy={register.isPending}
              idle={t("entry.register.submit")}
              pending={t("entry.register.submitting")}
            />
          </button>
        </div>
      </form>
    </>
  );
}
