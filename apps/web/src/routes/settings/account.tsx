import { useSuspenseQuery } from "@tanstack/react-query";
import { meQueryOptions } from "../../lib/auth";

/**
 * Sotto-pagina Account: i dati dell'utente corrente (email, ruolo). Visibile a
 * tutti gli utenti autenticati. Il logout vive nella sidebar del layout.
 */
export function SettingsAccountPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
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
                isAdmin ? "border-signal-dim/40 text-signal" : "border-line-strong text-fg-muted"
              }`}
            >
              {isAdmin ? "Admin" : "Member"}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
