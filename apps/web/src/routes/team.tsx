import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { CopyButton } from "../components/copy-button";
import { FormError, TextField } from "../components/field";
import { deleteInvite, postInvite, type Invite, type PendingInvite } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDate } from "../lib/format";
import { invitesQueryOptions, usersQueryOptions } from "../lib/queries";

/**
 * Pagina Team: chi ha accesso alla piattaforma. La sezione "Membri" (utenti
 * registrati) è in sola lettura per tutti; la sezione "Inviti in sospeso" e la
 * creazione di inviti compaiono solo per gli admin (gli endpoint relativi sono
 * comunque protetti lato server).
 */
export function TeamPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="mt-1 text-sm text-fg-muted">Chi ha accesso alla piattaforma.</p>
      </header>

      <div className="mt-6 flex flex-col gap-8">
        <MembersSection currentUserId={me.user.id} />
        {isAdmin && <InvitesSection />}
      </div>
    </div>
  );
}

/** Etichetta di ruolo coerente col badge della pagina impostazioni. */
function RoleBadge({ role }: { role: "admin" | "member" }) {
  const isAdmin = role === "admin";
  return (
    <span
      className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
        isAdmin ? "border-signal-dim/40 text-signal" : "border-line-strong text-fg-muted"
      }`}
    >
      {isAdmin ? "Admin" : "Membro"}
    </span>
  );
}

/** Tabella dei membri registrati: email, ruolo, "membro dal". Sola lettura. */
function MembersSection({ currentUserId }: { currentUserId: string }) {
  const { data: users } = useSuspenseQuery(usersQueryOptions);

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          Membri
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          {users.length} {users.length === 1 ? "membro" : "membri"}
        </span>
      </header>

      <ul className="divide-y divide-line">
        {users.map((user) => (
          <li
            key={user.id}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-[13px] text-fg">{user.email}</span>
              {user.id === currentUserId && (
                <span className="shrink-0 rounded-sm border border-line-strong px-1.5 py-0.5 font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
                  tu
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <span className="hidden font-mono text-[11px] text-fg-faint sm:inline">
                membro dal {formatDate(user.createdAt)}
              </span>
              <RoleBadge role={user.role} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Sezione inviti (solo admin): form di creazione + lista degli inviti in
 * sospeso con revoca. La lista è caricata qui (non nel loader) e tollera il
 * 403 dei member, anche se la sezione è già montata solo per gli admin.
 */
function InvitesSection() {
  const queryClient = useQueryClient();
  const { data: invites } = useQuery(invitesQueryOptions);
  const [email, setEmail] = useState("");
  const [created, setCreated] = useState<(Invite & { email: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (value: string) => postInvite(value),
    onSuccess: (invite, value) => {
      setCreated({ ...invite, email: value });
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: invitesQueryOptions.queryKey });
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "Errore imprevisto");
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    createMutation.mutate(email);
  }

  const createdUrl = created
    ? `${window.location.origin}/register?token=${encodeURIComponent(created.token)}`
    : null;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          Inviti in sospeso
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          solo admin
        </span>
      </header>

      <div className="px-4 py-4">
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-3"
          noValidate
        >
          <div className="min-w-0 flex-1">
            <TextField
              id="invite-email"
              label="Invita un utente"
              type="email"
              required
              placeholder="collega@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={createMutation.isPending || email.trim() === ""}
            className="shrink-0 rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
          >
            {createMutation.isPending ? "Creazione…" : "Crea invito"}
          </button>
        </form>

        <FormError message={error} />

        {created && createdUrl && (
          <div className="mt-4 rounded-sm border border-signal-dim/40 bg-ink-950/60 p-3">
            <p className="font-mono text-[11px] text-fg-muted">
              Invito per <span className="text-fg">{created.email}</span> creato.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code
                data-testid="invite-url"
                className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal"
              >
                {createdUrl}
              </code>
              <CopyButton text={createdUrl} label="Copia link di invito" />
            </div>
            <p className="mt-2 font-mono text-[11px] text-fg-faint">
              // consegnalo tu: il server non spedisce nulla
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
  if (invites.length === 0) {
    return (
      <p className="font-mono text-[11px] text-fg-faint">// nessun invito in sospeso</p>
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
  const queryClient = useQueryClient();
  const expired = new Date(invite.expiresAt).getTime() <= Date.now();
  const inviteUrl = `${window.location.origin}/register?token=${encodeURIComponent(invite.token)}`;

  const revokeMutation = useMutation({
    mutationFn: () => deleteInvite(invite.token),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: invitesQueryOptions.queryKey }),
  });

  function handleRevoke() {
    if (!window.confirm(`Revocare l'invito per ${invite.email}?`)) return;
    revokeMutation.mutate();
  }

  return (
    <li className="rounded-sm border border-line bg-ink-950/40 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px] text-fg">{invite.email}</p>
          <p className="mt-1 font-mono text-[11px] text-fg-faint">
            inviato il {formatDate(invite.createdAt)} ·{" "}
            {expired ? (
              <span className="text-danger">scaduto il {formatDate(invite.expiresAt)}</span>
            ) : (
              <span>scade il {formatDate(invite.expiresAt)}</span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRevoke}
          disabled={revokeMutation.isPending}
          className="shrink-0 rounded-sm border border-line-strong px-2 py-1 font-mono text-[10px] tracking-[0.14em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
        >
          {revokeMutation.isPending ? "Revoca…" : "Revoca"}
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal">
          {inviteUrl}
        </code>
        <CopyButton text={inviteUrl} label={`Copia link di invito per ${invite.email}`} />
      </div>
    </li>
  );
}
