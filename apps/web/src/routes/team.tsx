import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Avatar } from "../components/avatar";
import { ComboboxPicker } from "../components/combobox-picker";
import { CopyButton } from "../components/copy-button";
import { FormError, TextField } from "../components/field";
import {
  deleteInvite,
  linkGitIdentity,
  linkUserBitbucket,
  linkUserSlack,
  postInvite,
  unlinkGitIdentity,
  unlinkUserBitbucket,
  unlinkUserSlack,
  updateUserRole,
  type Invite,
  type ObservedAuthor,
  type PendingInvite,
  type SlackWorkspaceUser,
  type TeamUser,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDate } from "../lib/format";
import {
  invitesQueryOptions,
  observedAuthorsQueryOptions,
  slackWorkspaceUsersQueryOptions,
  usersQueryOptions,
} from "../lib/queries";
import { translateApiError } from "../lib/translate-api-error";

/**
 * Pagina Team: chi ha accesso alla piattaforma. La sezione "Membri" (utenti
 * registrati) è in sola lettura per tutti; la sezione "Inviti in sospeso" e la
 * creazione di inviti compaiono solo per gli admin (gli endpoint relativi sono
 * comunque protetti lato server).
 */
export function TeamPage() {
  const { t } = useTranslation();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="page">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("settings:team.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("settings:team.subtitle")}</p>
      </header>

      <div className="mt-6 flex flex-col gap-8">
        <MembersSection currentUserId={me.user.id} isAdmin={isAdmin} />
        {isAdmin && <InvitesSection />}
      </div>
    </div>
  );
}

/** Etichetta di ruolo coerente col badge della pagina impostazioni. */
function RoleBadge({ role }: { role: "admin" | "member" }) {
  const { t } = useTranslation();
  const isAdmin = role === "admin";
  return (
    <span
      className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
        isAdmin ? "border-signal-dim/40 text-signal" : "border-line-strong text-fg-muted"
      }`}
    >
      {isAdmin ? t("settings:team.admin") : t("settings:team.member")}
    </span>
  );
}

/**
 * Stato condiviso dei membri del workspace Slack per i picker di link/invito.
 * `useQuery` non-suspense abilitata solo per gli admin: l'endpoint risponde 400
 * `slack_not_configured` quando Slack è spento, e qui lo si traduce in un flag
 * `notConfigured` che disabilita le azioni con un hint anziché far esplodere la
 * pagina. La lista è `[]` finché non carica o se in errore.
 */
function useSlackWorkspace(enabled: boolean) {
  const query = useQuery({ ...slackWorkspaceUsersQueryOptions, enabled });
  const notConfigured =
    query.error instanceof Error &&
    "code" in query.error &&
    (query.error as { code?: string }).code === "slack_not_configured";
  return {
    users: query.data ?? [],
    isLoading: query.isLoading,
    // Slack non configurato O qualunque altro errore della query → azioni off.
    unavailable: notConfigured || (!query.isLoading && query.error != null),
  };
}

/** Link/hint mostrato quando Slack non è configurato: punta a Settings → Slack. */
function SlackNotConfiguredHint() {
  const { t } = useTranslation();
  return (
    <Link
      to="/settings/slack"
      className="font-mono text-[10px] tracking-[0.12em] text-fg-faint uppercase transition-colors hover:text-signal"
      title={t("settings:team.slackSettingsLink")}
    >
      {t("settings:team.slackNotConfiguredHint")}
    </Link>
  );
}

/**
 * Tabella dei membri registrati: avatar, email, stato Slack e ruolo. Per gli
 * admin aggiunge il link/unlink dell'identità Slack tramite un picker `select`.
 */
function MembersSection({ currentUserId, isAdmin }: { currentUserId: string; isAdmin: boolean }) {
  const { t } = useTranslation();
  const { data: users } = useSuspenseQuery(usersQueryOptions);
  const slack = useSlackWorkspace(isAdmin);
  // Autori git osservati per il picker di link (solo admin). NON suspense e con
  // degradazione graziosa: l'endpoint è admin-only, un errore/403 lascia la
  // lista vuota — la pagina resta viva, solo il picker non offre candidati.
  const observedAuthorsQuery = useQuery({ ...observedAuthorsQueryOptions, enabled: isAdmin });
  const observedAuthors = observedAuthorsQuery.data ?? [];

  // Display name Slack per slackUserId, per arricchire il badge "Linked".
  const slackNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of slack.users) {
      if (u.displayName) map.set(u.id, u.displayName);
    }
    return map;
  }, [slack.users]);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("settings:team.members")}
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:team.memberCount", { count: users.length })}
        </span>
      </header>

      <ul className="divide-y divide-line">
        {users.map((user) => (
          <MemberRow
            key={user.id}
            user={user}
            isCurrentUser={user.id === currentUserId}
            isAdmin={isAdmin}
            slackUsers={slack.users}
            slackUnavailable={slack.unavailable}
            slackName={user.slackUserId ? (slackNameById.get(user.slackUserId) ?? null) : null}
            observedAuthors={observedAuthors}
          />
        ))}
      </ul>
    </section>
  );
}

function MemberRow({
  user,
  isCurrentUser,
  isAdmin,
  slackUsers,
  slackUnavailable,
  slackName,
  observedAuthors,
}: {
  user: TeamUser;
  isCurrentUser: boolean;
  isAdmin: boolean;
  slackUsers: SlackWorkspaceUser[];
  slackUnavailable: boolean;
  slackName: string | null;
  observedAuthors: ObservedAuthor[];
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [pickingGit, setPickingGit] = useState(false);
  const [editingBitbucket, setEditingBitbucket] = useState(false);
  const [bitbucketInput, setBitbucketInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isLinked = user.slackUserId != null;

  const gitCount = user.gitIdentities.length;
  const gitLinked = gitCount > 0;
  const bitbucketLinked = user.bitbucketUsername != null;

  // Candidati del picker git: gli autori osservati non ancora aliasati a QUESTO
  // membro (quelli già suoi hanno linkedUserId === user.id e ricomparirebbero
  // come "già collegati"). Chi è aliasato a un ALTRO membro resta elencato ma
  // disabilitato (vedi GitPicker), così l'admin capisce perché non è scegliibile.
  const linkedEmails = new Set(user.gitIdentities.map((g) => g.email.toLowerCase()));
  const gitCandidates = observedAuthors.filter(
    (a) => !linkedEmails.has(a.email.toLowerCase()),
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: usersQueryOptions.queryKey });
    void queryClient.invalidateQueries({
      queryKey: slackWorkspaceUsersQueryOptions.queryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: observedAuthorsQueryOptions.queryKey,
    });
  }

  const linkMutation = useMutation({
    mutationFn: (slackUserId: string) => linkUserSlack(user.id, slackUserId),
    onSuccess: () => {
      setPicking(false);
      invalidate();
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  const unlinkMutation = useMutation({
    mutationFn: () => unlinkUserSlack(user.id),
    onSuccess: invalidate,
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  // Git: multi-valore (N email per membro). Il link accetta un'email dal picker
  // degli autori osservati o digitata a mano; l'unlink è per singola email.
  const linkGitMutation = useMutation({
    mutationFn: (email: string) => linkGitIdentity(user.id, email),
    onSuccess: () => {
      setPickingGit(false);
      invalidate();
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  const unlinkGitMutation = useMutation({
    mutationFn: (email: string) => unlinkGitIdentity(user.id, email),
    onSuccess: invalidate,
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  // Bitbucket: username singolo (users.bitbucketUsername, unique lato server).
  const linkBitbucketMutation = useMutation({
    mutationFn: (username: string) => linkUserBitbucket(user.id, username),
    onSuccess: () => {
      setEditingBitbucket(false);
      setBitbucketInput("");
      invalidate();
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  const unlinkBitbucketMutation = useMutation({
    mutationFn: () => unlinkUserBitbucket(user.id),
    onSuccess: invalidate,
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  // Cambio ruolo (solo admin, e mai sul proprio account): l'UI è comodità, i
  // safeguard (no auto-cambio, no declassamento dell'ultimo admin) sono
  // autoritativi lato server e tornano come ApiError tradotti per code.
  const roleMutation = useMutation({
    mutationFn: (role: "admin" | "member") => updateUserRole(user.id, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: usersQueryOptions.queryKey });
    },
    onError: (cause) => setError(translateApiError(cause, t)),
  });

  function handleUnlink() {
    if (!window.confirm(t("settings:team.confirmUnlink", { email: user.email }))) return;
    setError(null);
    unlinkMutation.mutate();
  }

  function handleUnlinkGit(email: string) {
    if (!window.confirm(t("settings:team.confirmUnlinkGit", { email }))) return;
    setError(null);
    unlinkGitMutation.mutate(email);
  }

  function handleUnlinkBitbucket() {
    if (!window.confirm(t("settings:team.confirmUnlinkBitbucket", { email: user.email }))) return;
    setError(null);
    unlinkBitbucketMutation.mutate();
  }

  function handleSubmitBitbucket(event: FormEvent) {
    event.preventDefault();
    const username = bitbucketInput.trim();
    if (username === "") return;
    setError(null);
    linkBitbucketMutation.mutate(username);
  }

  // Classi condivise dai bottoni-azione (link/unlink) della riga.
  const actionButton =
    "tap rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Avatar src={user.avatarUrl} label={user.email} size={24} />
        <span className="truncate font-mono text-[13px] text-fg">{user.email}</span>
        {isCurrentUser && (
          <span className="shrink-0 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
            {t("settings:team.you")}
          </span>
        )}
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ${
            isLinked ? "border-ok/40 text-ok" : "border-line-strong text-fg-faint"
          }`}
        >
          {isLinked
            ? slackName
              ? t("settings:team.slackLinkedTo", { name: slackName })
              : t("settings:team.slackLinked")
            : t("settings:team.slackNotLinked")}
        </span>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ${
            gitLinked ? "border-ok/40 text-ok" : "border-line-strong text-fg-faint"
          }`}
        >
          {gitLinked
            ? t("settings:team.gitLinkedCount", { count: gitCount })
            : t("settings:team.gitNotLinked")}
        </span>
        <span
          className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase ${
            bitbucketLinked ? "border-ok/40 text-ok" : "border-line-strong text-fg-faint"
          }`}
        >
          {bitbucketLinked
            ? t("settings:team.bitbucketLinkedTo", { username: user.bitbucketUsername })
            : t("settings:team.bitbucketNotLinked")}
        </span>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {isAdmin && isLinked && (
          <button
            type="button"
            onClick={handleUnlink}
            disabled={unlinkMutation.isPending}
            className={`${actionButton} hover:border-danger/40 hover:text-danger`}
          >
            {unlinkMutation.isPending ? t("settings:team.unlinking") : t("settings:team.unlink")}
          </button>
        )}
        {isAdmin && !isLinked && !picking && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPicking(true);
            }}
            disabled={slackUnavailable}
            className={`${actionButton} hover:border-signal-dim/40 hover:text-signal`}
          >
            {t("settings:team.linkSlack")}
          </button>
        )}
        {isAdmin && !isLinked && picking && (
          <SlackPicker
            slackUsers={slackUsers}
            pending={linkMutation.isPending}
            pendingLabel={t("settings:team.linking")}
            onCancel={() => setPicking(false)}
            onPick={(slackUserId) => {
              setError(null);
              linkMutation.mutate(slackUserId);
            }}
          />
        )}
        {isAdmin && slackUnavailable && !isLinked && <SlackNotConfiguredHint />}

        {isAdmin && !pickingGit && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPickingGit(true);
            }}
            className={`${actionButton} hover:border-signal-dim/40 hover:text-signal`}
          >
            {t("settings:team.linkGit")}
          </button>
        )}

        {isAdmin && bitbucketLinked && (
          <button
            type="button"
            onClick={handleUnlinkBitbucket}
            disabled={unlinkBitbucketMutation.isPending}
            className={`${actionButton} hover:border-danger/40 hover:text-danger`}
          >
            {unlinkBitbucketMutation.isPending
              ? t("settings:team.unlinking")
              : t("settings:team.unlinkBitbucket")}
          </button>
        )}
        {isAdmin && !bitbucketLinked && !editingBitbucket && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setEditingBitbucket(true);
            }}
            className={`${actionButton} hover:border-signal-dim/40 hover:text-signal`}
          >
            {t("settings:team.linkBitbucket")}
          </button>
        )}

        <span className="hidden font-mono text-[11px] text-fg-faint sm:inline">
          {t("settings:team.memberSince", { date: formatDate(user.createdAt) })}
        </span>
        {isAdmin && !isCurrentUser ? (
          <select
            aria-label={t("settings:team.changeRoleLabel", { email: user.email })}
            value={user.role}
            disabled={roleMutation.isPending}
            onChange={(event) => {
              setError(null);
              roleMutation.mutate(event.target.value as "admin" | "member");
            }}
            className="tap rounded-sm border border-line-strong bg-ink-950 px-2 py-1 font-mono text-[10px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal disabled:opacity-50"
          >
            <option value="admin">{t("settings:team.roleAdmin")}</option>
            <option value="member">{t("settings:team.roleMember")}</option>
          </select>
        ) : (
          <RoleBadge role={user.role} />
        )}
      </div>

      {/* Riga estesa (solo admin): chip delle email git, picker git e input
          Bitbucket. Sta sotto la riga principale per non affollarla. */}
      {isAdmin && (gitLinked || pickingGit || editingBitbucket) && (
        <div className="flex basis-full flex-col gap-2">
          {gitLinked && (
            <ul className="flex flex-wrap gap-1.5">
              {user.gitIdentities.map((identity) => (
                <li
                  key={identity.id}
                  className="inline-flex items-center gap-1.5 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
                >
                  <span className="truncate">{identity.email}</span>
                  <button
                    type="button"
                    aria-label={t("settings:team.gitUnlinkLabel", { email: identity.email })}
                    onClick={() => handleUnlinkGit(identity.email)}
                    disabled={unlinkGitMutation.isPending}
                    className="tap text-fg-faint transition-colors hover:text-danger disabled:opacity-50"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {pickingGit && (
            <GitPicker
              authors={gitCandidates}
              pending={linkGitMutation.isPending}
              pendingLabel={t("settings:team.linking")}
              onCancel={() => setPickingGit(false)}
              onPick={(email) => {
                setError(null);
                linkGitMutation.mutate(email);
              }}
            />
          )}
          {editingBitbucket && (
            <form onSubmit={handleSubmitBitbucket} className="flex items-center gap-2">
              <input
                type="text"
                aria-label={t("settings:team.bitbucketUsernameLabel")}
                placeholder={t("settings:team.bitbucketUsernamePlaceholder")}
                value={bitbucketInput}
                disabled={linkBitbucketMutation.isPending}
                onChange={(event) => setBitbucketInput(event.target.value)}
                className="w-full rounded-sm border border-line-strong bg-ink-950 px-2 py-1 font-mono text-[12px] text-fg placeholder:text-fg-faint disabled:opacity-50 sm:w-64"
              />
              <button
                type="submit"
                disabled={linkBitbucketMutation.isPending || bitbucketInput.trim() === ""}
                className={`${actionButton} hover:border-signal-dim/40 hover:text-signal`}
              >
                {linkBitbucketMutation.isPending
                  ? t("settings:team.linking")
                  : t("settings:team.bitbucketLink")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingBitbucket(false);
                  setBitbucketInput("");
                }}
                className={`${actionButton} hover:text-fg`}
              >
                {t("settings:team.cancel")}
              </button>
            </form>
          )}
        </div>
      )}

      {error && (
        <div className="basis-full">
          <FormError message={error} />
        </div>
      )}
    </li>
  );
}

/**
 * Picker dei membri del workspace Slack: sottile wrapper di {@link ComboboxPicker}
 * che filtra per displayName ed email, disabilita le voci già collegate ad altri
 * utenti e ne rende l'opzione con avatar. `onPick` riceve lo Slack user id.
 */
function SlackPicker({
  slackUsers,
  pending,
  pendingLabel,
  onPick,
  onCancel,
}: {
  slackUsers: SlackWorkspaceUser[];
  pending: boolean;
  pendingLabel: string;
  onPick: (slackUserId: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ComboboxPicker<SlackWorkspaceUser>
      items={slackUsers}
      getKey={(su) => su.id}
      matches={(su, q) =>
        (su.displayName ?? "").toLowerCase().includes(q) ||
        (su.email ?? "").toLowerCase().includes(q)
      }
      isDisabled={(su) => su.linkedUserId != null}
      renderOption={(su) => {
        const name = su.displayName ?? su.email ?? su.id;
        const taken = su.linkedUserId != null;
        return (
          <>
            <Avatar src={su.avatarUrl} label={name} size={20} />
            {taken ? (
              <span className="truncate">{t("settings:team.slackOptionLinked", { name })}</span>
            ) : (
              <span className="min-w-0 truncate">
                <span className="text-fg">{name}</span>
                {su.email && <span className="text-fg-faint"> · {su.email}</span>}
              </span>
            )}
          </>
        );
      }}
      onPick={(su) => onPick(su.id)}
      pending={pending}
      pendingLabel={pendingLabel}
      onCancel={onCancel}
      labels={{
        pickerLabel: t("settings:team.slackPickerLabel"),
        placeholder: t("settings:team.slackSearchPlaceholder"),
        noResults: t("settings:team.slackNoResults"),
        cancel: t("settings:team.cancel"),
        moreResults: (count) => t("settings:team.slackMoreResults", { count }),
      }}
    />
  );
}

/** Basilare riconoscimento di un'email per il valore libero del picker git. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+$/.test(value.trim());
}

/**
 * Picker degli autori git osservati: wrapper di {@link ComboboxPicker} che filtra
 * per email e authorName e disabilita le email già aliasate ad ALTRI membri.
 * Con `freeText` consente anche di digitare un'email non osservata e collegarla
 * comunque. `onPick` riceve l'email (già normalizzata lowercase).
 */
function GitPicker({
  authors,
  pending,
  pendingLabel,
  onPick,
  onCancel,
}: {
  authors: ObservedAuthor[];
  pending: boolean;
  pendingLabel: string;
  onPick: (email: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ComboboxPicker<ObservedAuthor>
      items={authors}
      getKey={(a) => a.email}
      matches={(a, q) =>
        a.email.toLowerCase().includes(q) || (a.authorName ?? "").toLowerCase().includes(q)
      }
      isDisabled={(a) => a.linkedUserId != null}
      renderOption={(a) => {
        const taken = a.linkedUserId != null;
        return taken ? (
          <span className="truncate">{t("settings:team.gitOptionLinked", { email: a.email })}</span>
        ) : (
          <span className="min-w-0 truncate">
            <span className="text-fg">{a.email}</span>
            {a.authorName && <span className="text-fg-faint"> · {a.authorName}</span>}
          </span>
        );
      }}
      onPick={(a) => onPick(a.email.toLowerCase())}
      pending={pending}
      pendingLabel={pendingLabel}
      onCancel={onCancel}
      labels={{
        pickerLabel: t("settings:team.gitPickerLabel"),
        placeholder: t("settings:team.gitSearchPlaceholder"),
        noResults: t("settings:team.gitNoResults"),
        cancel: t("settings:team.cancel"),
        moreResults: (count) => t("settings:team.gitMoreResults", { count }),
      }}
      freeText={{
        canSubmit: looksLikeEmail,
        label: (q) => t("settings:team.gitLinkEmail", { email: q.trim().toLowerCase() }),
        onSubmit: (q) => onPick(q.trim().toLowerCase()),
      }}
    />
  );
}

/**
 * Sezione inviti (solo admin): form di creazione + lista degli inviti in
 * sospeso con revoca. La lista è caricata qui (non nel loader) e tollera il
 * 403 dei member, anche se la sezione è già montata solo per gli admin.
 */
function InvitesSection() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: invites } = useQuery(invitesQueryOptions);
  const slack = useSlackWorkspace(true);
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<(Invite & { email: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickingSlack, setPickingSlack] = useState(false);

  const createMutation = useMutation({
    mutationFn: ({ value, slackUserId }: { value: string; slackUserId?: string }) =>
      postInvite(value, slackUserId),
    onSuccess: (invite, { value }) => {
      setCreated({ ...invite, email: value });
      setEmail("");
      setPickingSlack(false);
      void queryClient.invalidateQueries({ queryKey: invitesQueryOptions.queryKey });
    },
    onError: (cause) => {
      setError(translateApiError(cause, t));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    createMutation.mutate({ value: email });
  }

  // Email già in sospeso: best-effort per non riproporle nel picker Slack.
  const pendingEmails = new Set((invites ?? []).map((i) => i.email.toLowerCase()));
  // Solo membri Slack non collegati a Stubwise e non già invitati (con email nota).
  const slackInviteCandidates = slack.users.filter(
    (su) =>
      su.linkedUserId == null && su.email != null && !pendingEmails.has(su.email.toLowerCase()),
  );

  function handlePickSlack(slackUserId: string) {
    const picked = slack.users.find((su) => su.id === slackUserId);
    if (!picked?.email) return;
    setError(null);
    createMutation.mutate({ value: picked.email, slackUserId });
  }

  const createdUrl = created
    ? `${window.location.origin}/register?token=${encodeURIComponent(created.token)}`
    : null;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          {t("settings:team.invitesTitle")}
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          {t("settings:team.adminOnly")}
        </span>
      </header>

      <div className="px-4 py-4">
        <form onSubmit={handleSubmit} className="flex items-end gap-3" noValidate>
          <div className="min-w-0 flex-1">
            <TextField
              id="invite-email"
              label={t("settings:team.inviteUser")}
              type="email"
              required
              placeholder={t("settings:team.invitePlaceholder")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={createMutation.isPending || email.trim() === ""}
            className="shrink-0 rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
          >
            {createMutation.isPending
              ? t("settings:team.creatingInvite")
              : t("settings:team.createInvite")}
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {pickingSlack ? (
            <SlackPicker
              slackUsers={slackInviteCandidates}
              pending={createMutation.isPending}
              pendingLabel={t("settings:team.creatingInvite")}
              onCancel={() => setPickingSlack(false)}
              onPick={handlePickSlack}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setPickingSlack(true);
              }}
              disabled={slack.unavailable}
              className="tap rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("settings:team.inviteFromSlack")}
            </button>
          )}
          {slack.unavailable && <SlackNotConfiguredHint />}
        </div>

        <FormError message={error} />

        {created && createdUrl && (
          <div className="mt-4 rounded-sm border border-signal-dim/40 bg-ink-950/60 p-3">
            <p className="font-mono text-[11px] text-fg-muted">
              <Trans
                i18nKey="settings:team.inviteCreated"
                values={{ email: created.email }}
                components={{ strong: <span className="text-fg" /> }}
              />
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code
                data-testid="invite-url"
                className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal"
              >
                {createdUrl}
              </code>
              <CopyButton text={createdUrl} label={t("settings:team.copyInviteLink")} />
            </div>
            <p className="mt-2 font-mono text-[11px] text-fg-faint">
              {t("settings:team.deliverYourself")}
            </p>
          </div>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <InvitesList invites={invites ?? []} />
        </div>
      </div>
    </section>
  );
}

/** Lista degli inviti in sospeso con link, copia e revoca. */
function InvitesList({ invites }: { invites: PendingInvite[] }) {
  const { t } = useTranslation();
  if (invites.length === 0) {
    return (
      <p className="font-mono text-[11px] text-fg-faint">{t("settings:team.noPendingInvites")}</p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {invites.map((invite) => (
        <InviteRow key={invite.token} invite={invite} />
      ))}
    </ul>
  );
}

function InviteRow({ invite }: { invite: PendingInvite }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const expired = new Date(invite.expiresAt).getTime() <= Date.now();
  const inviteUrl = `${window.location.origin}/register?token=${encodeURIComponent(invite.token)}`;

  const revokeMutation = useMutation({
    mutationFn: () => deleteInvite(invite.token),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitesQueryOptions.queryKey }),
  });

  function handleRevoke() {
    if (!window.confirm(t("settings:team.confirmRevoke", { email: invite.email }))) return;
    revokeMutation.mutate();
  }

  return (
    <li className="rounded-sm border border-line bg-ink-950/40 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          {invite.slackUserId && (
            <Avatar src={invite.slackAvatarUrl} label={invite.email} size={20} />
          )}
          <div className="min-w-0">
            <p className="truncate font-mono text-[13px] text-fg">
              {invite.email}
              {invite.slackUserId && (
                <span className="ml-2 rounded-sm border border-ok/40 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.12em] text-ok uppercase">
                  {t("settings:team.viaSlack")}
                </span>
              )}
            </p>
            <p className="mt-1 font-mono text-[11px] text-fg-faint">
              {t("settings:team.sentOn", { date: formatDate(invite.createdAt) })} ·{" "}
              {expired ? (
                <span className="text-danger">
                  {t("settings:team.expiredOn", { date: formatDate(invite.expiresAt) })}
                </span>
              ) : (
                <span>{t("settings:team.expiresOn", { date: formatDate(invite.expiresAt) })}</span>
              )}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRevoke}
          disabled={revokeMutation.isPending}
          className="tap shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
        >
          {revokeMutation.isPending ? t("settings:team.revoking") : t("settings:team.revoke")}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal">
          {inviteUrl}
        </code>
        <CopyButton
          text={inviteUrl}
          label={t("settings:team.copyInviteLinkFor", { email: invite.email })}
        />
      </div>
    </li>
  );
}
