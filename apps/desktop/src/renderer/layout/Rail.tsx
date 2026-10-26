import { Link, useRouterState } from "@tanstack/react-router";
import { useId, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  useChatSignal,
  useMailProposalDecisions,
  useMyAutomationApprovals,
  useNotifications,
  usePinnedProjects,
  useWaitingOnMe,
} from "../data/queries";
import type { Project } from "../data/types";
import { getPlatform, shortcutLabel } from "../platform/platform";
import {
  AllProjectsIcon,
  AutomationsIcon,
  BellIcon,
  CalendarIcon,
  ChatIcon,
  ClaudeIcon,
  DriveIcon,
  HomeIcon,
  MailIcon,
  SearchIcon,
} from "./icons";
import { unreadCount } from "../notifications/time";
import { ProfileMenu } from "./ProfileMenu";
import { OverflowTile, ProjectTile, TileSignals, useOverflowSignals } from "./ProjectTile";
import { Tooltip } from "./Tooltip";
import { useFitSlots } from "./useFitSlots";
import { openNotifications, openPalette, useShortcuts } from "./useShortcuts";

const DESTINATIONS = [
  { to: "/home", key: "nav.home", icon: <HomeIcon />, shortcut: ["mod", "shift", "H"] },
  { to: "/chat", key: "nav.chat", icon: <ChatIcon /> },
  { to: "/mail", key: "nav.mail", icon: <MailIcon /> },
  { to: "/calendar", key: "nav.calendar", icon: <CalendarIcon /> },
  // Il Drive di tutti i progetti: nessun punto di segnale, non aspetta nessuno (A6).
  { to: "/drive", key: "nav.drive", icon: <DriveIcon /> },
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
  signal,
}: {
  to: string;
  label: string;
  icon: ReactNode;
  shortcut?: string | undefined;
  /**
   * Un segnale per chi guarda (la Chat: c'è qualcosa per te): il punto delle
   * tessere, e le stesse parole nella descrizione accessibile e nel tooltip.
   */
  signal?: string | undefined;
}) {
  const signalId = useId();
  return (
    <Tooltip label={signal ? `${label} · ${signal}` : label} shortcut={shortcut}>
      <Link
        to={to}
        aria-label={label}
        aria-describedby={signal ? signalId : undefined}
        className={`${controlClass} ${currentClass} relative`}
      >
        {icon}
        {signal && (
          <>
            <span
              aria-hidden="true"
              data-signal="chat"
              className="pointer-events-none absolute top-1.5 right-1.5 size-2.5 rounded-full border-2 border-rail bg-ink"
            />
            <span id={signalId} className="sr-only">
              {signal}
            </span>
          </>
        )}
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

/**
 * «All projects» quando l'unico posto delle tessere va al progetto aperto: il
 * «+N» delle nascoste diventa un contrassegno in basso a destra del
 * bottone, con i loro segnali (punto e anello, come la sentinella) e la
 * stessa frase nella descrizione accessibile e nel tooltip.
 */
function ProjectsWithCount({
  hidden,
  waitingIds,
}: {
  hidden: Project[];
  waitingIds: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const { label, waiting, claude } = useOverflowSignals(hidden, waitingIds);
  const descriptionId = useId();
  return (
    <Tooltip label={`${t("nav.projects")} · ${label}`}>
      <Link
        to="/projects"
        aria-label={t("nav.projects")}
        aria-describedby={descriptionId}
        className={`${controlClass} ${currentClass} relative`}
      >
        <AllProjectsIcon />
        <TileSignals waiting={waiting > 0} claude={claude} />
        {/* Dopo i segnali: il fondo del contrassegno copre l'anello che ci passa sotto. */}
        <span
          aria-hidden="true"
          data-rail-overflow-count
          className="num pointer-events-none absolute -right-[7px] -bottom-[7px] min-w-6 rounded-full border border-rule-strong bg-rail px-1 text-center text-xs leading-4 font-semibold text-ink"
        >
          +{hidden.length}
        </span>
        <span id={descriptionId} className="sr-only">
          {label}
        </span>
      </Link>
    </Tooltip>
  );
}

/** Tessera: 40 px più 8 di spazio. La zona ha 4 px di padding sopra e sotto. */
const TILE_FIT = { pitch: 48, gap: 8, inset: 8 };

export interface PinnedSplit {
  shown: { project: Project; index: number }[];
  hidden: Project[];
  /**
   * Il conteggio delle nascoste sta su «All projects» invece che nella
   * sentinella: un posto solo, che va al progetto aperto.
   */
  countOnGrid: boolean;
}

/**
 * Quali tessere mostrare in `slots` posti interi (`null` = tutti). Se non
 * entrano tutte, l'ultimo posto va alla sentinella con le restanti; il
 * progetto aperto resta sempre visibile, al posto dell'ultima tessera. Con
 * un posto solo e un progetto aperto il posto è suo (dove sono non si perde
 * mai), e il «+N» passa su «All projects» (`countOnGrid`). `index` è la
 * posizione originale (scorciatoia ⌘N).
 */
export function splitPinned(
  pinned: Project[],
  slots: number | null,
  activeCode?: string,
): PinnedSplit {
  const all = pinned.map((project, index) => ({ project, index }));
  if (slots === null || pinned.length <= slots) {
    return { shown: all, hidden: [], countOnGrid: false };
  }
  const active = all.find((e) => e.project.code === activeCode);
  const room = Math.max(0, slots - 1);
  const countOnGrid = room === 0 && active !== undefined && slots > 0;
  let shown = countOnGrid ? [active!] : all.slice(0, room);
  if (active && room > 0 && !shown.includes(active)) shown = [...shown.slice(0, room - 1), active];
  const kept = new Set(shown);
  return { shown, hidden: all.filter((e) => !kept.has(e)).map((e) => e.project), countOnGrid };
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
  const waiting = useWaitingOnMe();
  useShortcuts();
  const mac = getPlatform() === "mac";
  const tilesZone = useRef<HTMLDivElement>(null);
  const slots = useFitSlots(tilesZone, TILE_FIT);
  const activeCode = useRouterState({
    select: (s) => /^\/p\/([^/]+)/.exec(s.location.pathname)?.[1]?.toUpperCase(),
  });
  const { shown, hidden, countOnGrid } = splitPinned(pinned, slots, activeCode);
  const { data: notifications } = useNotifications();
  const unread = notifications ? unreadCount(notifications) : 0;
  // Solo ciò che è rivolto a chi guarda: menzioni dirette, DM, thread seguiti.
  const chatNews = useChatSignal().data === true;
  // La Posta: solo le proposte che aspettano chi guarda, mai le email non lette (A6).
  // Le Automations: solo le approvazioni e i «scegli il progetto» rivolti a me, mai le fallite ([A 4]).
  const automationsWaiting = (useMyAutomationApprovals().data ?? []).length;
  const mailWaiting = (useMailProposalDecisions().data ?? []).filter(
    (v) => v.proposal.source !== "calendar",
  ).length;

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
              signal={
                d.to === "/chat" && chatNews
                  ? t("rail.chatNews")
                  : d.to === "/mail" && mailWaiting > 0
                    ? t("rail.mailWaiting", { count: mailWaiting })
                    : d.to === "/automations" && automationsWaiting > 0
                      ? t("rail.automationsWaiting", { count: automationsWaiting })
                      : undefined
              }
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
              <ProjectTile project={project} index={index} waiting={waiting.has(project.id)} />
            </li>
          ))}
        </ul>
        {hidden.length > 0 && !countOnGrid && (
          <div className={shown.length > 0 ? "mt-2" : undefined}>
            <OverflowTile hidden={hidden} waitingIds={waiting} />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 pt-2">
        {countOnGrid ? (
          <ProjectsWithCount hidden={hidden} waitingIds={waiting} />
        ) : (
          <RailLink to="/projects" label={t("nav.projects")} icon={<AllProjectsIcon />} />
        )}
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
