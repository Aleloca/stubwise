import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { meQueryOptions } from "../../lib/auth";

/**
 * Voci della sotto-navigazione delle impostazioni. `adminOnly` filtra ciò che
 * un member non deve vedere: per loro resta solo "Account". Le rotte admin sono
 * comunque protette dalla guardia del router (vedi router.tsx) e dagli endpoint
 * lato server.
 */
const SETTINGS_NAV = [
  { to: "/settings/account", label: "Account", adminOnly: false },
  { to: "/settings/automation", label: "Automazione AI", adminOnly: true },
  { to: "/settings/notifications", label: "Notifiche", adminOnly: true },
  { to: "/settings/git-accounts", label: "Account Git", adminOnly: true },
] as const;

/**
 * Layout delle impostazioni: intestazione, sotto-navigazione a sinistra e il
 * contenuto della sotto-rotta a destra (Outlet). La sotto-nav mostra solo le
 * voci accessibili al ruolo corrente.
 */
export function SettingsLayout() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  const items = SETTINGS_NAV.filter((item) => isAdmin || !item.adminOnly);

  return (
    <div className="p-8">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">Il tuo account e l'automazione AI.</p>
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Impostazioni" className="flex flex-col gap-0.5">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group rounded-sm px-3 py-2 font-mono text-[12px] tracking-[0.04em] text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
              activeProps={{
                className: "bg-ink-800 text-fg shadow-[inset_2px_0_0_0_var(--color-signal)]",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
