import { Glyph } from "../claude/conversation/parts";

// I glifi della Posta: stesso tratto del binario (1.4 su griglia 16,
// `currentColor`), mai un colore proprio. Il significato lo dice il testo
// accanto o il nome accessibile di chi li usa.

/** «Important»: due chevron verso l'alto (importanza alta, A5). */
export const ImportantGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="m4 8.5 4-3.5 4 3.5M4 12.5 8 9l4 3.5" />
  </Glyph>
);

export const PaperclipGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.4-4.4" />
  </Glyph>
);

export const PencilGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="m10.5 2.8 2.7 2.7-7.4 7.4-3.3.6.6-3.3z" />
  </Glyph>
);

export const ClockGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.75V8l2.25 1.5" />
  </Glyph>
);

export const AlertGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 5v3.5M8 10.75h.01" />
  </Glyph>
);

export const CalendarDueGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M3 4.25h10v9H3zM3 7h10M5.75 2.75v2.5M10.25 2.75v2.5" />
  </Glyph>
);

export const VideoGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M2.25 4.75h8v6.5h-8zM10.25 7.25l3.5-2v5.5l-3.5-2" />
  </Glyph>
);

export const ImageGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M2.5 3.25h11v9.5h-11zM2.5 10.5l3-3 2.5 2.5 1.75-1.75 3.75 3.5" />
    <circle cx="10.25" cy="6" r="1" />
  </Glyph>
);

export const PersonPlusGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="6.5" cy="5.25" r="2.5" />
    <path d="M2 13.25a4.5 4.5 0 0 1 8.5-2M12.25 9v4.5M10 11.25h4.5" />
  </Glyph>
);

export const ArrowLeftGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M13 8H3m0 0 4-4M3 8l4 4" />
  </Glyph>
);

export const MoreGlyph = ({ size = 16 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth={2.2} />
  </Glyph>
);

export const SearchGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Glyph>
);
