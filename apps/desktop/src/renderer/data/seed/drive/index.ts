// Il seme del Drive (area 5): i file di AUD, MKX e STW (gli altri progetti
// non ne hanno), le aperture, gli account Google, le cartelle collegate e i
// file Google fuori dai progetti.
import type { DriveFile, DriveOpen } from "../../types";
import { AUD_FILES, AUD_OPENS } from "./aud";
import { MKX_FILES, MKX_OPENS } from "./mkx";
import { STW_FILES, STW_OPENS } from "./stw";

export { FOLDER_LINKS, GOOGLE_ACCOUNTS, GOOGLE_OUTSIDE_FILES } from "./google";

export const DRIVE_FILES: DriveFile[] = [...AUD_FILES, ...MKX_FILES, ...STW_FILES];

/** In ordine di tempo. */
export const DRIVE_OPENS: DriveOpen[] = [...AUD_OPENS, ...MKX_OPENS, ...STW_OPENS].sort((a, b) =>
  a.at.localeCompare(b.at),
);
