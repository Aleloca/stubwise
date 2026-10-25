import type { ReactNode } from "react";
import type { DriveFileType } from "../../data/types";

// I glifi del Drive: il tipo del file (lineare, `ink-muted`: niente colori
// dei formati, il colore è dei reparti), la cartella, il Drive di Google
// monocromo con la freccia d'uscita, e le azioni. Stesso tratto delle icone
// del binario, su griglia 16, `currentColor`.

function Glyph({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
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

/** Il foglio con l'angolo piegato: la base di ogni tipo. */
const SHEET = <path d="M4 1.75h5.25L12.5 5v9.25H4z M9.25 1.75V5h3.25" />;

const TYPE_MARKS: Record<DriveFileType, ReactNode> = {
  document: <path d="M6 8h4.5M6 10.25h4.5M6 12.5h3" />,
  sheet: <path d="M5.75 7.75h5v4.75h-5zM5.75 10.1h5M8.25 7.75v4.75" />,
  slides: <path d="M5.75 8h5v3.25h-5zM8.25 11.25v1.5" />,
  pdf: <path d="M6 12.5V8.5h1.25a1.1 1.1 0 0 1 0 2.2H6M9.5 8.5v4M9.5 8.5h1.5M9.5 10.4h1.2" />,
  image: <path d="m5.75 12.5 2-2.5 1.5 1.5 1-1 1 2M7 8.4a.6.6 0 1 0 0-.01" />,
  other: <path d="M6.25 9.5h4M6.25 11.75h2.5" />,
};

/** Il tipo di un file come glifo lineare (16 di base, 40 nella scheda Google). */
export function TypeGlyph({ type, size = 16 }: { type: DriveFileType; size?: number }) {
  return (
    <Glyph size={size}>
      {SHEET}
      {TYPE_MARKS[type]}
    </Glyph>
  );
}

export const FolderGlyph = () => (
  <Glyph>
    <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" />
  </Glyph>
);

/**
 * Il Drive di Google, monocromo (il triangolo a tre lati), con la freccia
 * d'uscita: il file si apre su Google, non qui. Il significato lo dice il
 * nome accessibile di chi lo usa.
 */
export const GoogleDriveGlyph = ({ size = 14 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M5.25 2.5h4l4.25 7.25-2 3.5H3l-2-3.5zM5.25 2.5l4.25 7.25H1M9.25 2.5 5 9.75l-2 3.5" />
  </Glyph>
);

export const ExternalGlyph = ({ size = 12 }: { size?: number }) => (
  <Glyph size={size}>
    <path d="M6.5 3H3.5a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H12a1 1 0 0 0 1-1v-3M9 2.5h4.5V7M13.5 2.5 7.5 8.5" />
  </Glyph>
);

export const DownloadGlyph = () => (
  <Glyph>
    <path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />
  </Glyph>
);

/** «Apri»: l'occhio dell'anteprima. */
export const OpenGlyph = () => (
  <Glyph>
    <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Glyph>
);

export const UploadGlyph = () => (
  <Glyph size={14}>
    <path d="M8 13V5.5M4.75 8.5 8 5.25l3.25 3.25M3 2.75h10" />
  </Glyph>
);

/** Un errore (contenuto non letto, caricamento fallito, troppo grande): il cerchio col punto esclamativo. */
export const ErrorGlyph = () => (
  <Glyph size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.75V8.5M8 11h.01" />
  </Glyph>
);

/** Non disponibile (cancellato su Google, accesso perso): il foglio barrato. */
export const UnavailableGlyph = () => (
  <Glyph size={14}>
    {SHEET}
    <path d="m2.5 14.5 11-12" />
  </Glyph>
);

/**
 * In elaborazione: un arco d'inchiostro che gira (fermo con movimento
 * ridotto, e allora resta un arco fermo, sempre accompagnato dalla parola).
 */
export const Spinner = () => (
  <svg
    viewBox="0 0 16 16"
    width={12}
    height={12}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    aria-hidden="true"
    focusable="false"
    className="shrink-0 animate-spin motion-reduce:animate-none"
  >
    <path d="M8 2a6 6 0 0 1 6 6" />
  </svg>
);
