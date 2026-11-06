// Il seme del Drive (area 5): i file di AUD, MKX e STW, più i tre di RNC
// (l'archiviato dell'area 9c; gli altri progetti non ne hanno), le
// aperture, gli account Google, le cartelle collegate e i file Google fuori
// dai progetti.
import type { DriveFile, DriveOpen } from "../../types";
import { ACQ_FILES } from "./acq";
import { AUD_FILES, AUD_OPENS } from "./aud";
import { MKX_FILES, MKX_OPENS } from "./mkx";
import { RNC_FILES } from "./rnc";
import { VRD_FILES } from "./vrd";
import { STW_FILES, STW_OPENS } from "./stw";

export { FOLDER_LINKS, GOOGLE_ACCOUNTS, GOOGLE_OUTSIDE_FILES } from "./google";
export { DRIVE_HIDDEN, GOOGLE_DRIVE_FILES, GOOGLE_FOLDERS, GOOGLE_UPDATES } from "./catalog";

export const DRIVE_FILES: DriveFile[] = [
  ...AUD_FILES,
  ...MKX_FILES,
  ...STW_FILES,
  ...RNC_FILES,
  ...ACQ_FILES,
  ...VRD_FILES,
];

/** In ordine di tempo. */
export const DRIVE_OPENS: DriveOpen[] = [...AUD_OPENS, ...MKX_OPENS, ...STW_OPENS].sort((a, b) =>
  a.at.localeCompare(b.at),
);
