import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Avatar } from "../components/avatar";
import { CopyButton } from "../components/copy-button";
import { FormError, TextField } from "../components/field";
import {
  deleteInvite,
  linkUserSlack,
  postInvite,
  unlinkUserSlack,
  type Invite,
  type PendingInvite,
  type SlackWorkspaceUser,
  type TeamUser,
} from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDate } from "../lib/format";
import {
  invitesQueryOptions,
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
}: {
  user: TeamUser;
  isCurrentUser: boolean;
  isAdmin: boolean;
  slackUsers: SlackWorkspaceUser[];
  slackUnavailable: boolean;
  slackName: string | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLinked = user.slackUserId != null;

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: usersQueryOptions.queryKey });
    void queryClient.invalidateQueries({
      queryKey: slackWorkspaceUsersQueryOptions.queryKey,
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

  function handleUnlink() {
    if (!window.confirm(t("settings:team.confirmUnlink", { email: user.email }))) return;
    setError(null);
    unlinkMutation.mutate();
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-2">
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
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {isAdmin && isLinked && (
          <button
            type="button"
            onClick={handleUnlink}
            disabled={unlinkMutation.isPending}
            className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
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
            className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
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
        <span className="hidden font-mono text-[11px] text-fg-faint sm:inline">
          {t("settings:team.memberSince", { date: formatDate(user.createdAt) })}
        </span>
        <RoleBadge role={user.role} />
      </div>

      {error && (
        <div className="basis-full">
          <FormError message={error} />
        </div>
      )}
    </li>
  );
}

/** Numero massimo di voci renderizzate nella lista del picker Slack. */
const SLACK_PICKER_MAX = 50;

/** Filtro case-insensitive dei membri Slack su displayName + email. */
function filterSlackUsers(slackUsers: SlackWorkspaceUser[], query: string): SlackWorkspaceUser[] {
  const q = query.trim().toLowerCase();
  if (!q) return slackUsers;
  return slackUsers.filter((su) => {
    const name = (su.displayName ?? "").toLowerCase();
    const email = (su.email ?? "").toLowerCase();
    return name.includes(q) || email.includes(q);
  });
}

/**
 * Picker dei membri del workspace Slack: un combobox con ricerca/autocomplete,
 * pensato per workspace grandi (centinaia di persone). L'input filtra le voci
 * per displayName ed email mentre si digita; la lista è scrollabile e cappata a
 * {@link SLACK_PICKER_MAX} voci, con una riga "+N altri" quando è troncata. Le
 * voci già collegate ad altri utenti restano elencate ma disabilitate (così
 * l'admin capisce perché non sono scegliibili). `onPick` scatta alla scelta di
 * un'opzione valida. Navigazione con ↑/↓/Invio; Esc chiama `onCancel`.
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
  const [query, setQuery] = useState("");
  // Indice attivo iniziale: prima voce selezionabile (le già-collegate sono
  // saltate dalle frecce e non selezionabili con Invio).
  const [active, setActive] = useState(() =>
    slackUsers.findIndex((su) => su.linkedUserId == null),
  );
  const listboxId = useId();

  // Filtro case-insensitive su displayName + email; cap a SLACK_PICKER_MAX voci
  // renderizzate, con conteggio del troncamento per la riga "+N altri".
  const { visible, overflow } = useMemo(() => {
    const matches = filterSlackUsers(slackUsers, query);
    return {
      visible: matches.slice(0, SLACK_PICKER_MAX),
      overflow: Math.max(0, matches.length - SLACK_PICKER_MAX),
    };
  }, [query, slackUsers]);

  // La listbox è renderizzata quando la mutation non è in corso: aria-expanded
  // deve riflettere esattamente questa visibilità, non lo stato di pending.
  const listboxOpen = !pending;

  function pick(su: SlackWorkspaceUser) {
    if (su.linkedUserId != null) return;
    onPick(su.id);
  }

  // Prossimo indice selezionabile (linkedUserId == null) in direzione `step`,
  // partendo da `from`. Le frecce saltano le voci disabilitate; se non c'è
  // nessuna voce selezionabile in quella direzione, l'indice resta invariato.
  function nextSelectable(from: number, step: 1 | -1): number {
    for (let i = from + step; i >= 0 && i < visible.length; i += step) {
      if (visible[i]?.linkedUserId == null) return i;
    }
    return from;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => nextSelectable(i, 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => nextSelectable(i, -1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const su = visible[active];
      if (su) pick(su);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          role="combobox"
          aria-expanded={listboxOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={t("settings:team.slackPickerLabel")}
          placeholder={t("settings:team.slackSearchPlaceholder")}
          disabled={pending}
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            // L'indice attivo punta alla prima voce selezionabile dei nuovi
            // risultati (le voci già collegate non sono scelibili): -1 se non
            // ce ne sono, così Invio non seleziona mai una voce disabilitata.
            const matches = filterSlackUsers(slackUsers, value).slice(0, SLACK_PICKER_MAX);
            setActive(matches.findIndex((su) => su.linkedUserId == null));
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-sm border border-line-strong bg-ink-950 px-2 py-1 font-mono text-[12px] text-fg placeholder:text-fg-faint disabled:opacity-50 sm:w-64"
        />
        {pending ? (
          <span className="font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase">
            {pendingLabel}
          </span>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:text-fg"
          >
            {t("settings:team.cancel")}
          </button>
        )}
      </div>

      {!pending && (
        <>
          <ul
            id={listboxId}
            role="listbox"
            aria-label={t("settings:team.slackPickerLabel")}
            className="max-h-56 w-full overflow-y-auto rounded-sm border border-line bg-ink-950 sm:w-72"
          >
            {visible.length === 0 ? (
              <li className="px-2 py-2 font-mono text-[11px] text-fg-faint">
                {t("settings:team.slackNoResults")}
              </li>
            ) : (
              visible.map((su, index) => {
                const name = su.displayName ?? su.email ?? su.id;
                const taken = su.linkedUserId != null;
                return (
                  <li
                    key={su.id}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={taken}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(su)}
                    className={`flex items-center gap-2 px-2 py-1.5 font-mono text-[12px] ${
                      taken
                        ? "cursor-not-allowed text-fg-faint"
                        : `cursor-pointer text-fg ${index === active ? "bg-signal/10" : ""}`
                    }`}
                  >
                    <Avatar src={su.avatarUrl} label={name} size={20} />
                    {taken ? (
                      <span className="truncate">
                        {t("settings:team.slackOptionLinked", { name })}
                      </span>
                    ) : (
                      <span className="min-w-0 truncate">
                        <span className="text-fg">{name}</span>
                        {su.email && <span className="text-fg-faint"> · {su.email}</span>}
                      </span>
                    )}
                  </li>
                );
              })
            )}
          </ul>
          {overflow > 0 && (
            <p className="font-mono text-[10px] tracking-[0.1em] text-fg-faint uppercase">
              {t("settings:team.slackMoreResults", { count: overflow })}
            </p>
          )}
        </>
      )}
    </div>
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
              className="rounded-sm border border-line-strong px-3 py-1.5 font-mono text-[11px] tracking-[0.1em] text-fg-muted uppercase transition-colors hover:border-signal-dim/40 hover:text-signal disabled:cursor-not-allowed disabled:opacity-50"
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
          className="shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
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
