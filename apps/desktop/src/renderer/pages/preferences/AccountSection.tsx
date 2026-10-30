import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  EMAIL_RE,
  MIN_PASSWORD_LENGTH,
  useChangePassword,
  useConnectMailbox,
  useDepartments,
  useDisconnectMailbox,
  useMyFolderLinks,
  useMyMailboxes,
  useMyProfile,
  usePinnedProjects,
  useReconnectMailbox,
  useSetMailboxProposals,
  useUpdateProfile,
  type GoogleConnectOutcome,
  type MyMailbox,
  type MyProfile,
} from "../../data/queries";
import { Dialog } from "../../tasks-ui/Dialog";
import { useToast } from "../../tasks-ui/Toast";
import { PrototypeBox } from "../automations/shared";
import { BusyLabel, EntryField, ErrorLine } from "../entry/parts";
import { dangerSolidButton, primaryButton, secondaryButton } from "../tasks/controls";
import { CheckGlyph, TriangleGlyph } from "./glyphs";
import {
  Part,
  PrefsPage,
  ReadError,
  RowMenu,
  RowMenuItem,
  RowsSkeleton,
  WriteError,
  refusalOf,
  rowButton,
  useFlash,
  whenSynced,
} from "./parts";
import { Switch } from "./SubscriptionRow";
import { WhoCanLink } from "../../components/WhoCanLink";

// Preferenze → Account (shape preferences-account.md): profilo (nome, email,
// foto), password, progetti seguiti, caselle Google. Le caselle sono le
// STESSE di Posta e Calendario (e l'account Google è anche quello del
// Drive): scollegare qui scollega là, e il dialogo lo dice.

export function AccountSection() {
  const { t } = useTranslation();
  const profile = useMyProfile();
  let body;
  if (profile.isError && !profile.data) {
    body = (
      <ReadError message={t("prefs.account.loadError")} onRetry={() => void profile.refetch()} />
    );
  } else if (profile.isPending) {
    body = <RowsSkeleton parts={2} />;
  } else {
    body = (
      <>
        <ProfilePart profile={profile.data} />
        <PasswordPart />
        <FollowsPart />
        <MailboxesPart />
      </>
    );
  }
  return (
    <PrefsPage title={t("prefs.sections.account")} intro={t("prefs.account.intro")}>
      {body}
    </PrefsPage>
  );
}

// --- profilo ------------------------------------------------------------------

function Avatar({ profile }: { profile: MyProfile }) {
  const departments = useDepartments().data;
  const dept = departments?.find((d) => d.id === profile.departmentId);
  const color = dept ? `var(${dept.colorToken})` : "var(--ink-muted)";
  if (profile.photo)
    return (
      <img src={profile.photo} alt="" className="size-14 shrink-0 rounded-full object-cover" />
    );
  // Le iniziali sul colore del reparto, come nel binario.
  return (
    <span
      aria-hidden="true"
      className="grid size-14 shrink-0 place-items-center rounded-full text-lg font-semibold"
      style={{ color, background: `color-mix(in oklch, ${color} 18%, var(--ground))` }}
    >
      {profile.initials}
    </span>
  );
}

function ProfilePart({ profile }: { profile: MyProfile }) {
  const { t } = useTranslation();
  const update = useUpdateProfile();
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, flashSaved] = useFlash();
  const file = useRef<HTMLInputElement>(null);
  const dirty = name !== profile.name || email !== profile.email;

  // Il profilo cambiato altrove (la foto, un'altra scheda) entra nei campi non toccati.
  useEffect(() => {
    if (!dirty) {
      setName(profile.name);
      setEmail(profile.email);
    }
  }, [profile.name, profile.email]);

  const cancel = () => {
    setName(profile.name);
    setEmail(profile.email);
    setNameError(null);
    setEmailError(null);
  };

  function save(e?: FormEvent) {
    e?.preventDefault();
    setNameError(null);
    setEmailError(null);
    setFailed(false);
    if (!name.trim()) return setNameError(t("prefs.account.profile.nameEmpty"));
    if (!EMAIL_RE.test(email.trim())) return setEmailError(t("prefs.account.profile.invalidEmail"));
    const input = {
      ...(name !== profile.name ? { name } : {}),
      ...(email !== profile.email ? { email } : {}),
    };
    update.mutate(input, {
      onSuccess: (r) => {
        const refusal = refusalOf(r);
        if (!refusal) return flashSaved();
        if (refusal.reason === "name") setNameError(t("prefs.account.profile.nameEmpty"));
        else if (refusal.reason === "email") setEmailError(t("prefs.account.profile.invalidEmail"));
        else if (refusal.reason === "email_taken")
          setEmailError(t("prefs.account.profile.emailTaken"));
        else setFailed(true);
      },
      onError: () => setFailed(true),
    });
  }

  /** La foto si sceglie da un file locale e resta in memoria: nessun caricamento. */
  function pickPhoto(picked: File | undefined) {
    setPhotoError(null);
    if (!picked) return;
    if (!picked.type.startsWith("image/"))
      return setPhotoError(t("prefs.account.profile.notImage"));
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string")
        update.mutate({ avatar: reader.result }, { onError: () => setFailed(true) });
    };
    reader.readAsDataURL(picked);
  }

  return (
    <Part title={t("prefs.account.profile.title")}>
      <div className="flex items-center gap-4 pt-1">
        <Avatar profile={profile} />
        <div className="flex flex-wrap gap-1">
          <button type="button" className={secondaryButton} onClick={() => file.current?.click()}>
            {t("prefs.account.profile.changePhoto")}
          </button>
          {profile.photo && (
            <button
              type="button"
              className={rowButton + " h-8"}
              onClick={() => update.mutate({ avatar: null }, { onError: () => setFailed(true) })}
            >
              {t("prefs.account.profile.removePhoto")}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              pickPhoto(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      {photoError && (
        <div className="mt-2">
          <ErrorLine>{photoError}</ErrorLine>
        </div>
      )}
      <form noValidate onSubmit={save} className="mt-4 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <EntryField
            label={t("prefs.account.profile.name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={nameError}
            autoComplete="name"
          />
          <EntryField
            label={t("prefs.account.profile.email")}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
            autoComplete="email"
          />
        </div>
        {failed && (
          <WriteError message={t("prefs.account.profile.saveFailed")} onRetry={() => save()} />
        )}
        {(dirty || saved) && (
          <div className="flex min-h-8 items-center gap-2">
            {dirty && (
              <>
                <button type="submit" className={primaryButton} aria-busy={update.isPending}>
                  <BusyLabel
                    busy={update.isPending}
                    idle={t("prefs.common.save")}
                    pending={t("prefs.common.saving")}
                  />
                </button>
                <button type="button" className={secondaryButton} onClick={cancel}>
                  {t("prefs.common.cancel")}
                </button>
              </>
            )}
            {saved && !dirty && (
              <span role="status" className="flex items-center gap-1.5 text-sm text-ink-muted">
                <span className="text-positive">
                  <CheckGlyph size={14} />
                </span>
                {t("prefs.common.saved")}
              </span>
            )}
          </div>
        )}
      </form>
    </Part>
  );
}

// --- password -------------------------------------------------------------------

function PasswordPart() {
  const { t } = useTranslation();
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<{
    field: "current" | "next" | "confirm";
    text: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const noteId = useId();

  function submit(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setFailed(false);
    setDone(null);
    if (next !== confirm)
      return setError({ field: "confirm", text: t("prefs.account.password.mismatch") });
    if (next.length < MIN_PASSWORD_LENGTH)
      return setError({
        field: "next",
        text: t("prefs.account.password.short", { count: MIN_PASSWORD_LENGTH }),
      });
    change.mutate(
      { current, next },
      {
        onSuccess: (r) => {
          const refusal = refusalOf(r);
          if (!refusal) {
            setCurrent("");
            setNext("");
            setConfirm("");
            return setDone((r as { signedOut: number }).signedOut);
          }
          if (refusal.reason === "wrong_password")
            setError({ field: "current", text: t("prefs.account.password.wrong") });
          else if (refusal.reason === "too_short")
            setError({
              field: "next",
              text: t("prefs.account.password.short", { count: MIN_PASSWORD_LENGTH }),
            });
          else setFailed(true);
        },
        onError: () => setFailed(true),
      },
    );
  }

  const errorOf = (field: "current" | "next" | "confirm") =>
    error?.field === field ? error.text : null;
  return (
    <Part title={t("prefs.account.password.title")}>
      <form noValidate onSubmit={submit} className="flex max-w-[360px] flex-col gap-3 pt-1">
        <EntryField
          label={t("prefs.account.password.current")}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errorOf("current")}
        />
        <EntryField
          label={t("prefs.account.password.next")}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={errorOf("next")}
        />
        <EntryField
          label={t("prefs.account.password.confirm")}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errorOf("confirm")}
        />
        <p id={noteId} className="text-sm text-ink-muted">
          {t("prefs.account.password.note")}
        </p>
        {failed && (
          <WriteError message={t("prefs.account.password.failed")} onRetry={() => submit()} />
        )}
        <div>
          <button
            type="submit"
            className={primaryButton}
            aria-describedby={noteId}
            aria-busy={change.isPending}
            disabled={!current || !next || !confirm}
          >
            <BusyLabel
              busy={change.isPending}
              idle={t("prefs.account.password.submit")}
              pending={t("prefs.account.password.submitting")}
            />
          </button>
        </div>
        {done !== null && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-sm text-ink">
            <span className="text-positive">
              <CheckGlyph size={14} />
            </span>
            {done > 0
              ? t("prefs.account.password.done", { count: done })
              : t("prefs.account.password.doneNone")}
            <Link
              to="/preferences/$section"
              params={{ section: "security" }}
              className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
            >
              {t("prefs.account.password.seeSessions")}
            </Link>
          </p>
        )}
      </form>
    </Part>
  );
}

// --- progetti seguiti -----------------------------------------------------------

/** I progetti seguiti sono i fissati (la stella di All projects): una riga sola [PR 3]. */
function FollowsPart() {
  const { t } = useTranslation();
  const pinned = usePinnedProjects();
  const count = pinned.data?.length;
  return (
    <Part title={t("prefs.account.follows.title")}>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-md text-ink-muted">
        {count === undefined ? (
          <span aria-busy="true">{t("taskUi.states.loading")}</span>
        ) : (
          <span>
            {count > 0
              ? t("prefs.account.follows.body", { count })
              : t("prefs.account.follows.none")}
          </span>
        )}
        <Link
          to="/projects"
          search={{ view: "pinned" }}
          className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-ink"
        >
          {t("prefs.account.follows.manage")}
        </Link>
      </p>
    </Part>
  );
}

// --- caselle Google -------------------------------------------------------------

type ConnectTarget = { kind: "connect" } | { kind: "reconnect"; mailbox: MyMailbox };

function MailboxesPart() {
  const { t } = useTranslation();
  const boxes = useMyMailboxes();
  const [dialog, setDialog] = useState<ConnectTarget | null>(null);
  const data = boxes.data;
  const canConnect = !!data && data.workspaces.length > 0 && data.mailboxes.length === 0;

  let body;
  if (boxes.isError && !data) {
    body = (
      <WriteError message={t("prefs.google.loadError")} onRetry={() => void boxes.refetch()} />
    );
  } else if (!data) {
    body = (
      <p aria-busy="true" className="skeleton-breathe h-11 text-sm text-ink-muted">
        {t("taskUi.states.loading")}
      </p>
    );
  } else if (data.workspaces.length === 0 && data.mailboxes.length === 0) {
    body = (
      <p className="flex flex-wrap items-baseline gap-x-2 text-md text-ink-muted">
        {t("prefs.google.noWorkspace")}
        <span className="basis-full text-sm">
          {t("prefs.google.whoCanAnswer")}{" "}
          <WhoCanLink action="manageIntegrations" projectId={null} />
        </span>
      </p>
    );
  } else if (data.mailboxes.length === 0) {
    body = <p className="text-md text-ink-muted">{t("prefs.google.empty")}</p>;
  } else {
    body = (
      <ul className="@container">
        {data.mailboxes.map((b) => (
          <MailboxRow
            key={b.id}
            mailbox={b}
            onReconnect={() => setDialog({ kind: "reconnect", mailbox: b })}
          />
        ))}
      </ul>
    );
  }

  return (
    <Part
      title={t("prefs.google.title")}
      action={
        canConnect && (
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setDialog({ kind: "connect" })}
          >
            {t("prefs.google.connect")}
          </button>
        )
      }
    >
      <p className="mb-2 max-w-[62ch] text-sm text-ink-muted">{t("prefs.google.intro")}</p>
      {body}
      {dialog && data && (
        <ConnectDialog
          target={dialog}
          workspaces={data.workspaces}
          onClose={() => setDialog(null)}
        />
      )}
    </Part>
  );
}

function MailboxRow({ mailbox: b, onReconnect }: { mailbox: MyMailbox; onReconnect: () => void }) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const proposals = useSetMailboxProposals();
  const disconnect = useDisconnectMailbox();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<"proposals" | "disconnect" | null>(null);
  const folders = useMyFolderLinks(confirming).data;
  const hintId = useId();
  const needs = b.status === "needs_reconnect";

  const status = needs ? (
    <span className="flex items-start gap-1.5 text-ink">
      <span className="mt-0.5 shrink-0 text-warning">
        <TriangleGlyph size={13} />
      </span>
      {t("prefs.google.needsReconnect")}
    </span>
  ) : b.sync === "syncing" ? (
    t("prefs.google.syncing")
  ) : b.sync === "failed" ? (
    t("prefs.google.syncFailed")
  ) : (
    <span className="flex items-center gap-1.5">
      <span className="text-positive">
        <CheckGlyph size={13} />
      </span>
      {t("prefs.google.connected", { when: whenSynced(b.syncedAt, i18n.language) })}
    </span>
  );

  const setOn = (on: boolean) => {
    setError(null);
    proposals.mutate(
      { id: b.id, on },
      {
        onSuccess: (r) => refusalOf(r) && setError("proposals"),
        onError: () => setError("proposals"),
      },
    );
  };
  const doDisconnect = () => {
    setError(null);
    disconnect.mutate(b.id, {
      onSuccess: (r) => {
        if (refusalOf(r)) return setError("disconnect");
        toast.show(t("prefs.google.disconnected", { email: b.email }));
      },
      onError: () => setError("disconnect"),
    });
  };

  return (
    <li className="border-b border-rule last:border-b-0">
      {/* A 1440 tutto su una riga; a 1024 lo stato scende sotto, l'interruttore resta a destra. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2 @[680px]:min-h-11">
        <div className="flex min-w-0 flex-col gap-0.5 @[680px]:flex-row @[680px]:items-baseline @[680px]:gap-3">
          {/* L'indirizzo resta intero finché può: è lo stato a andare a capo. */}
          <span className="flex min-w-0 items-baseline gap-2 @[680px]:max-w-[60%] @[680px]:shrink-0">
            <span title={b.email} className="truncate text-md text-ink">
              {b.email}
            </span>
            {b.workspaceName && (
              <span className="shrink-0 text-sm text-ink-muted">{b.workspaceName}</span>
            )}
          </span>
          <span className="min-w-0 text-sm text-ink-muted @[680px]:ml-auto">{status}</span>
        </div>
        <div className="flex items-center gap-2">
          <span id={hintId} className="sr-only">
            {t("prefs.google.proposalsHint")}
          </span>
          <span aria-hidden="true" className="text-sm text-ink-muted">
            {t("prefs.google.proposals")}
          </span>
          <Switch
            checked={b.proposalsEnabled}
            label={t("prefs.google.proposals")}
            describedBy={hintId}
            onChange={setOn}
          />
          {needs && (
            <button type="button" className={`${rowButton} text-ink`} onClick={onReconnect}>
              {t("prefs.google.reconnect")}
            </button>
          )}
          <RowMenu label={t("prefs.google.more", { email: b.email })}>
            {(close) => (
              <RowMenuItem
                onSelect={() => {
                  close(false);
                  setConfirming(true);
                }}
              >
                {t("prefs.google.disconnect")}
              </RowMenuItem>
            )}
          </RowMenu>
        </div>
      </div>
      {error === "proposals" && (
        <div className="pb-2">
          <WriteError message={t("prefs.google.proposalsFailed")} />
        </div>
      )}
      {confirming && (
        <div
          role="group"
          aria-label={t("prefs.google.disconnectSure")}
          className="alert-group-enter mb-3 flex flex-col gap-2 rounded-md border border-rule px-3 py-3"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setConfirming(false);
            }
          }}
        >
          <p className="text-md text-ink">{t("prefs.google.disconnectMail", { email: b.email })}</p>
          {/* L'account Google è uno solo: con la casella smette di aggiornarsi anche il Drive. */}
          <p className="text-sm text-ink-muted">
            {t("prefs.google.disconnectDrive")}{" "}
            {folders === undefined
              ? t("taskUi.states.loading")
              : folders.length > 0
                ? t("drive.account.disconnectFolders", {
                    count: folders.length,
                    names: folders.map((f) => f.name).join(", "),
                  })
                : t("drive.account.disconnectNone")}
          </p>
          {error === "disconnect" && (
            <WriteError message={t("prefs.google.disconnectFailed")} onRetry={doDisconnect} />
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              autoFocus
              className={dangerSolidButton}
              disabled={disconnect.isPending}
              onClick={doDisconnect}
            >
              {t("prefs.google.disconnectSure")}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setConfirming(false)}>
              {t("prefs.common.cancel")}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

const OUTCOMES: GoogleConnectOutcome[] = [
  "connected",
  "wrong_domain",
  "scopes_missing",
  "owned_by_other",
  "failed",
];

/** Il dialogo di collegamento (480 px): il Workspace, il consenso del web, «Continue on Google». */
function ConnectDialog({
  target,
  workspaces,
  onClose,
}: {
  target: ConnectTarget;
  workspaces: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const connect = useConnectMailbox();
  const reconnect = useReconnectMailbox();
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [outcome, setOutcome] = useState<GoogleConnectOutcome>("connected");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const name = useId();
  const busy = connect.isPending || reconnect.isPending;
  const reconnecting = target.kind === "reconnect";

  function go() {
    setError(null);
    setTried(true);
    const done = (r: unknown) => {
      const refusal = refusalOf(r);
      if (!refusal) {
        if (target.kind === "reconnect")
          toast.show(t("prefs.google.dialog.reconnected", { email: target.mailbox.email }));
        else
          toast.show(
            t("prefs.google.dialog.connected", {
              email: (r as { mailbox: MyMailbox }).mailbox.email,
            }),
          );
        return onClose();
      }
      const reason = refusal.reason ?? "failed";
      setError(
        t(`prefs.google.dialog.errors.${reason}`, {
          defaultValue: t("prefs.google.dialog.errors.failed"),
        }),
      );
    };
    const fail = () => setError(t("prefs.google.dialog.errors.failed"));
    if (target.kind === "reconnect")
      reconnect.mutate({ id: target.mailbox.id, outcome }, { onSuccess: done, onError: fail });
    else connect.mutate({ workspaceId, outcome }, { onSuccess: done, onError: fail });
  }

  return (
    <Dialog
      title={
        reconnecting
          ? t("prefs.google.dialog.reconnectTitle", { email: target.mailbox.email })
          : t("prefs.google.dialog.title")
      }
      width={480}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("prefs.google.dialog.cancel")}
          </button>
          <button
            type="button"
            data-autofocus
            className={primaryButton}
            aria-busy={busy}
            disabled={!reconnecting && !workspaceId}
            onClick={go}
          >
            <BusyLabel
              busy={busy}
              idle={
                tried && error
                  ? t("prefs.google.dialog.tryAgain")
                  : t("prefs.google.dialog.continue")
              }
              pending={t("prefs.google.dialog.continuing")}
            />
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!reconnecting && workspaces.length > 1 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-ink">
              {t("prefs.google.dialog.workspace")}
            </legend>
            {workspaces.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-md text-ink">
                <input
                  type="radio"
                  name={`${name}-ws`}
                  checked={workspaceId === w.id}
                  onChange={() => setWorkspaceId(w.id)}
                  className="size-3.5"
                />
                {w.name}
              </label>
            ))}
          </fieldset>
        )}
        {!reconnecting && workspaces.length === 1 && (
          <p className="text-sm text-ink-muted">
            {t("prefs.google.dialog.workspace")}:{" "}
            <span className="text-ink">{workspaces[0]!.name}</span>
          </p>
        )}
        <p className="text-md text-ink">{t("prefs.google.dialog.consent")}</p>
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
      <PrototypeBox>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm text-ink-muted">{t("prefs.google.dialog.answer")}</legend>
          {OUTCOMES.map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`${name}-outcome`}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
                className="size-3.5"
              />
              {t(`prefs.google.dialog.outcomes.${o}`)}
            </label>
          ))}
        </fieldset>
      </PrototypeBox>
    </Dialog>
  );
}
