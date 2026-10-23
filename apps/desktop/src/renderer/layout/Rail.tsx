import { Link, useRouterState } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNotifications, usePinnedProjects } from "../data/queries";
import type { Project } from "../data/types";
import { getPlatform, shortcutLabel } from "../platform/platform";
import {
  AllProjectsIcon,
  AutomationsIcon,
  BellIcon,
  CalendarIcon,
  ChatIcon,
  ClaudeIcon,
  HomeIcon,
  MailIcon,
  SearchIcon,
} from "./icons";
import { unreadCount } from "../notifications/time";
import { ProfileMenu } from "./ProfileMenu";
import { OverflowTile, ProjectTile } from "./ProjectTile";
import { Tooltip } from "./Tooltip";
import { useFitSlots } from "./useFitSlots";
import { openNotifications, openPalette, useShortcuts } from "./useShortcuts";

const DESTINATIONS = [
  { to: "/home", key: "nav.home", icon: <HomeIcon />, shortcut: ["mod", "shift", "H"] },
  { to: "/chat", key: "nav.chat", icon: <ChatIcon /> },
  { to: "/mail", key: "nav.mail", icon: <MailIcon /> },
  { to: "/calendar", key: "nav.calendar", icon: <CalendarIcon /> },
  { to: "/claude", key: "nav.claude", icon: <ClaudeIcon /> },
  { to: "/automations", key: "nav.automations", icon: <AutomationsIcon /> },
] as const;

const controlClass =
  "grid size-10 place-items-center rounded-lg text-ink-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-ink/6 hover:text-ink active:bg-ink/10";
const currentClass = "aria-[current=page]:bg-ink/10 aria-[current=page]:text-ink";

function RailLink({
  to,
  label,
  icon,
  shortcut,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <Link to={to} aria-label={label} className={`${controlClass} ${currentClass}`}>
        {icon}
      </Link>
    </Tooltip>
  );
}

function RailButton({
  label,
  icon,
  shortcut,
  badge,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  shortcut?: string;
  /** Punto in alto a destra (es. notifiche non lette); il significato sta nell'`aria-label`. */
  badge?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={`${controlClass} relative`}
      >
        {icon}
        {badge && (
          <span
            data-unread-dot
            aria-hidden="true"
            className="absolute top-1.5 right-1.5 size-2.5 rounded-full border-2 border-rail bg-ink"
          />
        )}
      </button>
    </Tooltip>
  );
}

/** Tessera: 40 px più 8 di spazio. La zona ha 4 px di padding sopra e sotto. */
const TILE_FIT = { pitch: 48, gap: 8, inset: 8 };

export interface PinnedSplit {
  shown: { project: Project; index: number }[];
  hidden: Project[];
}

/**
 * Quali tessere mostrare in `slots` posti interi (`null` = tutti). Se non
 * entrano tutte, l'ultimo posto va alla sentinella con le restanti; il
 * progetto aperto resta sempre visibile, al posto dell'ultima tessera.
 * `index` è la posizione originale (scorciatoia ⌘N).
 */
export function splitPinned(
  pinned: Project[],
  slots: number | null,
  activeCode?: string,
): PinnedSplit {
  const all = pinned.map((project, index) => ({ project, index }));
  if (slots === null || pinned.length <= slots) return { shown: all, hidden: [] };
  const room = Math.max(0, slots - 1);
  let shown = all.slice(0, room);
  const active = all.find((e) => e.project.code === activeCode);
  if (active && room > 0 && !shown.includes(active)) shown = [...shown.slice(0, room - 1), active];
  const kept = new Set(shown);
  return { shown, hidden: all.filter((e) => !kept.has(e)).map((e) => e.project) };
}

/** Il logo: monogramma «S_», l'unico monospace dell'app (`font-logo`: `font-mono` è la sans). */
function Logo() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("rail.logo")}
      className="grid size-8 place-items-center rounded-lg bg-[#0f1318] font-logo text-[13px] font-semibold tracking-[-0.02em] text-[#f5a623] shadow-[inset_0_0_0_1px_var(--rule-strong)] select-none"
    >
      S_
    </span>
  );
}

/**
 * Il binario (64 px): logo, destinazioni, tessere dei progetti fissati (la
 * sola zona elastica: quelle che non entrano finiscono nella sentinella «+N»),
 * «Tutti i progetti», e in fondo — sempre visibili —
 * notifiche, palette e profilo. Registra anche le scorciatoie globali.
 */
export function Rail() {
  const { t } = useTranslation();
  const { data: pinned = [] } = usePinnedProjects();
  useShortcuts();
  const mac = getPlatform() === "mac";
  const tilesZone = useRef<HTMLDivElement>(null);
  const slots = useFitSlots(tilesZone, TILE_FIT);
  const activeCode = useRouterState({
    select: (s) => /^\/p\/([^/]+)/.exec(s.location.pathname)?.[1]?.toUpperCase(),
  });
  const { shown, hidden } = splitPinned(pinned, slots, activeCode);
  const { data: notifications } = useNotifications();
  const unread = notifications ? unreadCount(notifications) : 0;

  return (
    <nav
      aria-label={t("rail.label")}
      data-zone="rail"
      className="flex min-h-0 flex-col items-center border-r border-rule bg-rail"
    >
      {/* La cima del binario trascina la finestra. Su mac i semafori stanno
          sopra il logo (36 px); su Windows i controlli sono a destra, sopra l'area di lavoro. */}
      <div data-drag-region className="w-full shrink-0 [-webkit-app-region:drag]">
        {mac && <div aria-hidden="true" data-traffic-light-space className="h-9" />}
        <div className="flex h-14 items-center justify-center">
          <Logo />
        </div>
      </div>

      <ul className="flex shrink-0 flex-col items-center gap-1">
        {DESTINATIONS.map((d) => (
          <li key={d.to}>
            <RailLink
              to={d.to}
              label={t(d.key)}
              icon={d.icon}
              shortcut={"shortcut" in d ? shortcutLabel([...d.shortcut]) : undefined}
            />
          </li>
        ))}
      </ul>

      <div aria-hidden="true" className="my-3 h-px w-8 shrink-0 bg-rule" />

      {/* Le tessere non scorrono: la zona mostra solo tessere intere, e se non
          entrano tutte l'ultimo posto è la sentinella «+N» con i segnali delle
          nascoste. Così niente tessera tagliata a metà né stato invisibile. */}
      <div
        ref={tilesZone}
        data-tiles-zone
        className="flex min-h-0 w-full flex-1 flex-col items-center overflow-hidden py-1"
      >
        <ul aria-label={t("rail.pinned")} className="flex flex-col items-center gap-2">
          {shown.map(({ project, index }) => (
            <li key={project.id}>
              <ProjectTile project={project} index={index} />
            </li>
          ))}
        </ul>
        {hidden.length > 0 && (
          <div className={shown.length > 0 ? "mt-2" : undefined}>
            <OverflowTile hidden={hidden} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 pt-2">
        <RailLink to="/projects" label={t("nav.projects")} icon={<AllProjectsIcon />} />
      </div>

      <div className="mt-2 flex w-full shrink-0 flex-col items-center gap-1 border-t border-rule pt-2 pb-3">
        <RailButton
          label={
            unread > 0 ? t("rail.notificationsUnread", { count: unread }) : t("rail.notifications")
          }
          icon={<BellIcon />}
          badge={unread > 0}
          onClick={openNotifications}
        />
        <RailButton
          label={t("rail.palette")}
          icon={<SearchIcon />}
          shortcut={shortcutLabel(["mod", "K"])}
          onClick={openPalette}
        />
        <ProfileMenu />
      </div>
    </nav>
  );
}
