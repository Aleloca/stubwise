import { useSuspenseQuery } from "@tanstack/react-query";
import { meQueryOptions } from "../lib/auth";

/**
 * Impostazioni: dati dell'account corrente. La gestione degli accessi (membri
 * e inviti) vive nella pagina Team.
 */
export function SettingsPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Il tuo account.</p>
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
      </div>
    </div>
  );
}
