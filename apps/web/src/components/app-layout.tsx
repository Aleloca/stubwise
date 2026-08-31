import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { postLogout } from "../lib/api";
import { meQueryOptions } from "../lib/auth";
import { useCloseOnRouteChange } from "../lib/use-close-on-route-change";
import { Avatar } from "./avatar";
import { Drawer } from "./drawer";
import { GlobalSearchPalette } from "./global-search-palette";
import { InboxBell, useInboxUnreadWatcher } from "./inbox-bell";
import { Wordmark } from "./wordmark";

/**
 * Uno spazio Docs (`/docs/<repositoryId>` e figli) gestisce da sé il proprio
 * Cmd/K (apre la palette in scope repository): lì il trigger globale di
 * app-layout NON deve intercettare, per non aprire DUE palette. Esclude l'hub
 * `/docs` e la landing di progetto `/docs/project/<id>`.
 */
function isDocsSpacePath(pathname: string): boolean {
  const match = /^\/docs\/([^/]+)/.exec(pathname);
  if (!match) return false;
  return match[1] !== "project";
}

const NAV_ITEMS = [
  // L'inbox è la prima voce perché è la home operativa: quello che aspetta una
  // decisione viene prima di qualunque elenco da sfogliare.
  { to: "/inbox", labelKey: "common:nav.inbox", code: "INB" },
  { to: "/tickets", labelKey: "common:nav.tickets", code: "TKT" },
  { to: "/board", labelKey: "common:nav.board", code: "BRD" },
  { to: "/backlog", labelKey: "common:nav.backlog", code: "BLG" },
  { to: "/projects", labelKey: "common:nav.projects", code: "PRJ" },
  { to: "/repositories", labelKey: "common:nav.repositories", code: "REP" },
  { to: "/monitor", labelKey: "common:nav.monitor", code: "MON" },
  { to: "/activity", labelKey: "common:nav.activity", code: "ACT" },
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
          className={`group flex items-baseline gap-3 rounded-sm px-3 py-2 text-sm text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg ${
            // Solo nel drawer mobile (onNavigate presente) alziamo il target
            // touch a ~44px; la sidebar desktop resta invariata.
            onNavigate ? "min-h-11" : ""
          }`}
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
function MobileTopBar({
  navOpen,
  onToggle,
  onOpenSearch,
  searchLabel,
}: {
  navOpen: boolean;
  onToggle: () => void;
  onOpenSearch: () => void;
  searchLabel: string;
}) {
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
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label={searchLabel}
        className="ml-auto rounded-sm p-1.5 text-fg-muted transition-colors hover:bg-ink-800 hover:text-fg"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="size-5"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
      </button>
      <InboxBell />
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
  // Spotlight globale (Cmd/K): scope "global". Dentro uno spazio Docs il Cmd/K è
  // gestito dalla route Docs (scope repository), quindi qui NON lo intercettiamo.
  const [searchOpen, setSearchOpen] = useState(false);
  // Pathname del router (non `window.location`, che con la memory history dei
  // test resta `/`): serve al gate del Cmd/K per non collidere con la palette
  // Docs. Tenuto in un ref così il listener keydown resta stabile (registrato
  // una volta) e legge sempre il valore corrente.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  // Unico punto in cui il contatore delle non lette pilota le liste: il layout
  // monta una volta sola, mentre la campanella è renderizzata due volte
  // (sidebar + top bar mobile). Vedi `useInboxUnreadWatcher`.
  useInboxUnreadWatcher();

  // Callback stabile: `useCloseOnRouteChange` ha `close` nelle deps del suo
  // effect, quindi un closure inline (nuova identità a ogni render) lo farebbe
  // scattare a ogni render e riazzererebbe `navOpen`. Con `useCallback` scatta
  // solo al cambio di pathname, com'è inteso.
  const closeNav = useCallback(() => setNavOpen(false), []);
  useCloseOnRouteChange(closeNav);

  // Scorciatoia globale Cmd/Ctrl+K: apre lo spotlight in scope globale, TRANNE
  // dentro uno spazio Docs (che ha il proprio handler in scope repository): così
  // c'è un solo trigger attivo alla volta, mai due palette aperte.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (isDocsSpacePath(pathnameRef.current)) return;
        event.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
        {/* Testata: wordmark a sinistra, campanella a destra — stessa posizione
            che ha nella top bar mobile, così l'occhio la cerca in un punto solo. */}
        <div className="flex items-center justify-between gap-2 border-b border-line px-5 py-4">
          <Link to="/tickets" className="inline-block">
            <Wordmark className="text-base" />
          </Link>
          <InboxBell />
        </div>

        <div className="px-3 pt-3">
          <SearchAffordance label={t("search:trigger")} onOpen={() => setSearchOpen(true)} />
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
        <MobileTopBar
          navOpen={navOpen}
          onToggle={() => setNavOpen((v) => !v)}
          onOpenSearch={() => setSearchOpen(true)}
          searchLabel={t("search:label")}
        />
        {/* `relative`: il main è lo scroller delle pagine. Senza un contesto di
            posizionamento, un elemento absolute renderizzato dalle pagine (es.
            le label `sr-only`, che sono position:absolute) si ancorerebbe al
            documento, sfuggendo a scroll/clipping e allungando l'html oltre il
            viewport (bug: scroll oltre il contenuto sul dettaglio backlog). */}
        <main className="relative min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>

      {/* Spotlight globale (Cmd/K): modale a livello di app, sempre scope globale. */}
      <GlobalSearchPalette
        scope="global"
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </div>
  );
}

/**
 * Affordance visibile dello spotlight nella sidebar: un `<button>` full-width in
 * stile "box di ricerca" che apre la palette globale, con un kbd `⌘K` a destra.
 */
function SearchAffordance({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-sm border border-line-strong bg-ink-950/70 px-3 py-2 text-left text-[13px] text-fg-muted transition-colors hover:border-ink-700 hover:text-fg"
    >
      <span aria-hidden="true" className="shrink-0 text-fg-faint">
        ⌕
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <kbd className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] text-fg-faint">
        ⌘K
      </kbd>
    </button>
  );
}
