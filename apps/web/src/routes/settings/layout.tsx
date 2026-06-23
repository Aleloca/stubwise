import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { meQueryOptions } from "../../lib/auth";

/**
 * Voci della sotto-navigazione delle impostazioni. `adminOnly` filtra ciò che
 * un member non deve vedere: per loro resta solo "Account". Le rotte admin sono
 * comunque protette dalla guardia del router (vedi router.tsx) e dagli endpoint
 * lato server. La `labelKey` punta a `settings:layout.nav.*`.
 */
const SETTINGS_NAV = [
  { to: "/settings/account", labelKey: "account", adminOnly: false },
  { to: "/settings/automation", labelKey: "automation", adminOnly: true },
  { to: "/settings/notifications", labelKey: "notifications", adminOnly: true },
  { to: "/settings/usage", labelKey: "usage", adminOnly: true },
  { to: "/settings/git-accounts", labelKey: "gitAccounts", adminOnly: true },
  { to: "/settings/storage", labelKey: "storage", adminOnly: true },
  { to: "/settings/slack", labelKey: "slack", adminOnly: true },
  { to: "/settings/ai-providers", labelKey: "aiProviders", adminOnly: true },
] as const;

/**
 * Layout delle impostazioni: intestazione, sotto-navigazione a sinistra e il
 * contenuto della sotto-rotta a destra (Outlet). La sotto-nav mostra solo le
 * voci accessibili al ruolo corrente.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const isAdmin = me.user.role === "admin";
  const items = SETTINGS_NAV.filter((item) => isAdmin || !item.adminOnly);

  return (
    <div className="page">
      <header className="border-b border-line pb-4">
        <h1 className="text-xl font-semibold">{t("settings:layout.title")}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t("settings:layout.subtitle")}</p>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
        {/* Sotto `lg` la sotto-nav è una tab bar orizzontale scrollabile (più
            ergonomica della lista verticale mono su mobile); da `lg` torna alla
            colonna laterale verticale, identica al desktop attuale. */}
        <nav
          aria-label={t("settings:layout.navAriaLabel")}
          className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-x-visible lg:px-0 lg:pb-0"
        >
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="group shrink-0 rounded-sm px-3 py-2 font-mono text-[12px] whitespace-nowrap tracking-[0.04em] text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
              activeProps={{
                className: "bg-ink-800 text-fg shadow-[inset_2px_0_0_0_var(--color-signal)]",
              }}
            >
              {t(`settings:layout.nav.${item.labelKey}`)}
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
