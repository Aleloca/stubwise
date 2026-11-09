import type { ReactNode } from "react";

/** Icone del binario: tratto 1.4 su griglia 16 (circa 1.6 px a 18 px), `currentColor`. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={18}
      height={18}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export const HomeIcon = () => (
  <Icon>
    <path d="M2.5 7.2 8 2.8l5.5 4.4" />
    <path d="M4 6v7.5h8V6" />
    <path d="M6.75 13.5V10h2.5v3.5" />
  </Icon>
);

export const ChatIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />
  </Icon>
);

export const MailIcon = () => (
  <Icon>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="m2.5 4.5 5.5 4 5.5-4" />
  </Icon>
);

export const CalendarIcon = () => (
  <Icon>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </Icon>
);

/** Claude: una scintilla a quattro punte, non il marchio. */
/** Il Drive: un cassetto d'archivio con la maniglia (non il marchio di Google). */
export const DriveIcon = () => (
  <Icon>
    <path d="M2.5 3.5h11v4h-11zM3.25 7.5v5h9.5v-5" />
    <path d="M6.5 5.5h3M6.5 10h3" />
  </Icon>
);

export const ClaudeIcon = () => (
  <Icon>
    <path d="M8 2v3.2M8 10.8V14M2 8h3.2M10.8 8H14M3.8 3.8l2.3 2.3M9.9 9.9l2.3 2.3M12.2 3.8 9.9 6.1M6.1 9.9l-2.3 2.3" />
  </Icon>
);

export const AutomationsIcon = () => (
  <Icon>
    <path d="M9 2 4 9h4l-1 5 5-7H8z" />
  </Icon>
);

export const AllProjectsIcon = () => (
  <Icon>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
    <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3z" />
    <path d="M6.75 14h2.5" />
  </Icon>
);

export const SearchIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
);
