import { Link } from "@tanstack/react-router";
import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePinnedProjects } from "../data/queries";
import { shortcutLabel } from "../platform/platform";
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
import { ProfileMenu } from "./ProfileMenu";
import { ProjectTile } from "./ProjectTile";
import { Tooltip } from "./Tooltip";
import { useScrollCues } from "./useScrollCues";
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
  onClick,
}: {
  label: string;
  icon: ReactNode;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button type="button" aria-label={label} onClick={onClick} className={controlClass}>
        {icon}
      </button>
    </Tooltip>
  );
}

/** Il logo: monogramma «S_», l'unico monospace dell'app. */
function Logo() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("rail.logo")}
      className="grid size-8 place-items-center rounded-lg bg-[#0f1318] font-mono text-[13px] font-semibold tracking-[-0.02em] text-[#f5a623] shadow-[inset_0_0_0_1px_var(--rule-strong)] select-none"
    >
      S_
    </span>
  );
}

/**
 * Il binario (64 px): logo, destinazioni, tessere dei progetti fissati (la
 * sola zona che scorre), «Tutti i progetti», e in fondo — sempre visibili —
 * notifiche, palette e profilo. Registra anche le scorciatoie globali.
 */
export function Rail() {
  const { t } = useTranslation();
  const { data: pinned = [] } = usePinnedProjects();
  useShortcuts();
  const tilesZone = useRef<HTMLDivElement>(null);
  const cues = useScrollCues(tilesZone, pinned.length);

  return (
    <nav
      aria-label={t("rail.label")}
      data-zone="rail"
      className="flex min-h-0 flex-col items-center border-r border-rule bg-rail"
    >
      <div className="flex h-14 shrink-0 items-center">
        <Logo />
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

      <div className="relative flex min-h-0 w-full flex-1 flex-col">
        <div
          ref={tilesZone}
          className="flex min-h-0 w-full flex-1 flex-col items-center"
          style={{ overflowY: "auto", scrollbarWidth: "none" }}
        >
          <ul aria-label={t("rail.pinned")} className="flex flex-col items-center gap-2 py-1">
            {pinned.map((project, index) => (
              <li key={project.id}>
                <ProjectTile project={project} index={index} />
              </li>
            ))}
          </ul>
        </div>
        {/* La barra di scorrimento è nascosta: un filetto e una sfumatura sul
            bordo dicono che c'è altro, solo dal lato dove c'è. */}
        {cues.above && (
          <div
            aria-hidden="true"
            data-scroll-cue="above"
            className="pointer-events-none absolute inset-x-0 top-0 h-6 border-t border-rule-strong bg-linear-to-b from-rail to-transparent"
          />
        )}
        {cues.below && (
          <div
            aria-hidden="true"
            data-scroll-cue="below"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 border-b border-rule-strong bg-linear-to-t from-rail to-transparent"
          />
        )}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 pt-2">
        <RailLink to="/projects" label={t("nav.projects")} icon={<AllProjectsIcon />} />
      </div>

      <div className="mt-2 flex w-full shrink-0 flex-col items-center gap-1 border-t border-rule pt-2 pb-3">
        <RailButton
          label={t("rail.notifications")}
          icon={<BellIcon />}
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
