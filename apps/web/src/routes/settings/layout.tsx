import { Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCanFn, type Permission } from "../../lib/permissions";

/**
 * Voci della sotto-navigazione delle impostazioni. `anyOf` elenca i permessi
 * (calcolati dal server) di cui ne basta uno per vedere la voce; vuoto = per
 * tutti. Sono gli stessi della guardia del router (vedi router.tsx), e gli
 * endpoint lato server restano l'autorità. La `labelKey` punta a
 * `settings:layout.nav.*`.
 *
 * ⚠️ "google" è per tutti dalla fase 6c: la pagina porta la sezione
 * «Posta ammessa», visibile a ogni utente (scrittura solo admin, gestita
 * dentro la pagina — vedi `settings/google.tsx`), oltre al registro dei
 * Google Workspace che resta solo admin. Un member deve poter arrivarci dal
 * link di navigazione, non solo digitando l'URL.
 */
const SETTINGS_NAV: readonly {
  to: string;
  labelKey: string;
  anyOf: readonly Permission[];
}[] = [
  { to: "/settings/account", labelKey: "account", anyOf: [] },
  { to: "/settings/access-tokens", labelKey: "accessTokens", anyOf: [] },
  { to: "/settings/claude-code", labelKey: "claudeCode", anyOf: [] },
  { to: "/settings/automation", labelKey: "automation", anyOf: ["settings.manage"] },
  { to: "/settings/notifications", labelKey: "notifications", anyOf: ["settings.manage"] },
  { to: "/settings/usage", labelKey: "usage", anyOf: ["usage.view", "project.usage.view"] },
  { to: "/settings/git-accounts", labelKey: "gitAccounts", anyOf: ["git_accounts.manage"] },
  { to: "/settings/storage", labelKey: "storage", anyOf: ["settings.manage"] },
  { to: "/settings/slack", labelKey: "slack", anyOf: ["settings.manage"] },
  { to: "/settings/google", labelKey: "google", anyOf: [] },
  { to: "/settings/ai-providers", labelKey: "aiProviders", anyOf: ["ai_providers.manage"] },
  { to: "/settings/plugins", labelKey: "plugins", anyOf: ["plugins.manage"] },
  { to: "/settings/roles", labelKey: "roles", anyOf: ["roles.manage"] },
];

/**
 * Layout delle impostazioni: intestazione, sotto-navigazione a sinistra e il
 * contenuto della sotto-rotta a destra (Outlet). La sotto-nav mostra solo le
 * voci accessibili coi permessi correnti.
 */
export function SettingsLayout() {
  const { t } = useTranslation();
  const can = useCanFn();
  const items = SETTINGS_NAV.filter(
    (item) => item.anyOf.length === 0 || item.anyOf.some((permission) => can(permission)),
  );

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
