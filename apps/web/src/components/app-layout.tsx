import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { postLogout } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { useCloseOnRouteChange } from "../lib/use-close-on-route-change";
import { Avatar } from "./avatar";
import { Drawer } from "./drawer";
import { Wordmark } from "./wordmark";

const NAV_ITEMS = [
  { to: "/tickets", labelKey: "common:nav.tickets", code: "TKT" },
  { to: "/board", labelKey: "common:nav.board", code: "BRD" },
  { to: "/projects", labelKey: "common:nav.projects", code: "PRJ" },
  { to: "/docs", labelKey: "common:nav.docs", code: "DOC" },
  { to: "/team", labelKey: "common:nav.team", code: "TEA" },
  { to: "/settings", labelKey: "common:nav.settings", code: "SET" },
] as const;

/**
 * Lista dei link di navigazione: unica sorgente di `NAV_ITEMS`, riusata dalla
 * sidebar desktop e dal drawer mobile. `onNavigate` permette al drawer di
 * chiudersi quando si tocca una voce.
 */
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className="group flex items-baseline gap-3 rounded-sm px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
          activeProps={{
            className: "bg-ink-800 text-fg shadow-[inset_2px_0_0_0_var(--color-signal)]",
          }}
        >
          {/* Il Link attivo espone data-status="active": la sigla si accende. */}
          <span className="font-mono text-[10px] tracking-[0.18em] text-fg-faint group-data-[status=active]:text-signal">
            {item.code}
          </span>
          {t(item.labelKey)}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Barra superiore mobile (`md:hidden`): hamburger che apre il drawer di
 * navigazione + wordmark. Su desktop la sidebar la sostituisce.
 */
function MobileTopBar({ navOpen, onToggle }: { navOpen: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-ink-900 px-4 md:hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={navOpen}
        aria-controls="mobile-nav"
        aria-label={t("common:nav.open")}
        className="-ml-1 rounded-sm p-1.5 text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          className="size-5"
        >
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
      <Link to="/tickets" className="inline-block">
        <Wordmark className="text-sm" />
      </Link>
    </div>
  );
}

/**
 * Layout autenticato: sidebar di navigazione a sinistra, contenuto a destra.
 * L'utente arriva qui solo dopo la guardia del router, quindi la query `me`
 * è già in cache e la suspense non scatta in pratica.
 */
export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(meQueryOptions);
  const { t, i18n } = useTranslation();
  const [loggingOut, setLoggingOut] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  // Callback stabile: `useCloseOnRouteChange` ha `close` nelle deps del suo
  // effect, quindi un closure inline (nuova identità a ogni render) lo farebbe
  // scattare a ogni render e riazzererebbe `navOpen`. Con `useCallback` scatta
  // solo al cambio di pathname, com'è inteso.
  const closeNav = useCallback(() => setNavOpen(false), []);
  useCloseOnRouteChange(closeNav);

  // Allinea la lingua della UI alla preferenza persistita dell'utente: questo
  // layout monta su ogni pagina autenticata, quindi è il primo punto dopo il
  // login dove l'utente (con `language`) è disponibile. Pre-login si resta
  // sulla lingua iniziale (browser → it, altrimenti en).
  const userLanguage = data.user.language;
  useEffect(() => {
    if (i18n.language !== userLanguage) {
      void i18n.changeLanguage(userLanguage);
    }
  }, [i18n, userLanguage]);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await postLogout();
    } finally {
      // La cache va svuotata in ogni caso: il server pulisce comunque la
      // sessione best-effort e la UI non deve mostrare dati di un altro login.
      queryClient.clear();
      await navigate({ to: "/login" });
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar desktop: invariata da `md` in su, nascosta su mobile. */}
      <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-ink-900 md:flex">
        <div className="border-b border-line px-5 py-4">
          <Link to="/tickets" className="inline-block">
            <Wordmark className="text-base" />
          </Link>
        </div>

        <NavLinks />

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-2 px-3 pb-2" title={data.user.email}>
            <Avatar src={data.user.avatarUrl} label={data.user.email} size={22} />
            <p className="truncate font-mono text-[11px] text-fg-muted">{data.user.email}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="w-full rounded-sm border border-line-strong px-3 py-1.5 text-left font-mono text-[11px] tracking-[0.12em] text-fg-muted uppercase transition-colors hover:border-danger/40 hover:text-danger disabled:opacity-50"
          >
            {loggingOut ? t("common:loggingOut") : t("common:logout")}
          </button>
        </div>
      </aside>

      {/* Drawer di navigazione mobile: stessa NavLinks della sidebar. */}
      <Drawer
        open={navOpen}
        onClose={() => setNavOpen(false)}
        side="left"
        aria-label={t("common:nav.label")}
      >
        <div id="mobile-nav" className="flex h-full flex-col">
          <div className="border-b border-line px-5 py-4">
            <Link to="/tickets" className="inline-block">
              <Wordmark className="text-base" />
            </Link>
          </div>
          <NavLinks onNavigate={() => setNavOpen(false)} />
        </div>
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar navOpen={navOpen} onToggle={() => setNavOpen((v) => !v)} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
