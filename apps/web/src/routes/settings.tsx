import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { CopyButton } from "../components/copy-button";
import { FormError, TextField } from "../components/field";
import { postInvite, type Invite } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { formatDateTime } from "../lib/format";

/**
 * Impostazioni: account corrente e, per gli admin, creazione degli inviti.
 * Il link di registrazione con il token va consegnato fuori banda (email,
 * chat): il server non spedisce nulla.
 */
export function SettingsPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Account e accessi all&apos;istanza.</p>
      </header>

      <div className="mt-6 grid items-start gap-8 lg:grid-cols-2">
        <section className="rounded-sm border border-line bg-ink-900">
          <header className="border-b border-line px-4 py-3">
            <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
              Account
            </h2>
          </header>
          <dl className="space-y-3 px-4 py-4">
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                Email
              </dt>
              <dd className="font-mono text-[13px] text-fg">{me.user.email}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-[0.16em] text-fg-faint uppercase">
                Ruolo
              </dt>
              <dd>
                <span
                  className={`inline-flex rounded-sm border px-2 py-0.5 font-mono text-[11px] tracking-[0.08em] uppercase ${
                    isAdmin
                      ? "border-signal-dim/40 text-signal"
                      : "border-line-strong text-fg-muted"
                  }`}
                >
                  {isAdmin ? "Admin" : "Member"}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        {isAdmin && <InvitePanel />}
      </div>
    </div>
  );
}

/**
 * Pannello inviti (solo admin): email → POST /api/auth/invites → link di
 * registrazione pronto da copiare. Il token compare una volta sola.
 */
function InvitePanel() {
  const [email, setEmail] = useState("");
  const [invite, setInvite] = useState<(Invite & { email: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const created = await postInvite(email);
      setInvite({ ...created, email });
      setEmail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Errore imprevisto");
    } finally {
      setPending(false);
    }
  }

  const inviteUrl = invite
    ? `${window.location.origin}/register?token=${encodeURIComponent(invite.token)}`
    : null;

  return (
    <section className="rounded-sm border border-line bg-ink-900">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h2 className="font-mono text-[11px] font-medium tracking-[0.16em] text-fg-muted uppercase">
          Invita un utente
        </h2>
        <span className="font-mono text-[10px] tracking-[0.14em] text-fg-faint uppercase">
          solo admin
        </span>
      </header>

      <div className="px-4 py-4">
        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex items-end gap-3"
          noValidate
        >
          <div className="min-w-0 flex-1">
            <TextField
              id="invite-email"
              label="Email"
              type="email"
              required
              placeholder="collega@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <button
            type="submit"
            disabled={pending || email.trim() === ""}
            className="shrink-0 rounded-sm bg-signal px-4 py-2 font-mono text-[12px] font-semibold tracking-[0.08em] text-ink-950 uppercase transition-colors hover:bg-signal-bright active:bg-signal-dim disabled:cursor-not-allowed disabled:bg-signal-dim disabled:opacity-60"
          >
            {pending ? "Creazione…" : "Crea invito"}
          </button>
        </form>

        {error && <FormError message={error} />}

        {invite && inviteUrl && (
          <div className="mt-4 rounded-sm border border-signal-dim/40 bg-ink-950/60 p-3">
            <p className="font-mono text-[11px] text-fg-muted">
              Invito per <span className="text-fg">{invite.email}</span> — scade il{" "}
              {formatDateTime(invite.expiresAt)}.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code
                data-testid="invite-url"
                className="min-w-0 flex-1 truncate rounded-sm border border-line bg-ink-950/70 px-3 py-1.5 font-mono text-[12px] text-signal"
              >
                {inviteUrl}
              </code>
              <CopyButton text={inviteUrl} label="Copia link di invito" />
            </div>
            <p className="mt-2 font-mono text-[11px] text-fg-faint">
              // consegnalo tu: il token compare solo qui, una volta sola
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
