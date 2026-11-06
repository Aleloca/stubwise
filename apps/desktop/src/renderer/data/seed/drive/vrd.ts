import type { DriveFile } from "../../types";
import { at, ready, upload } from "./helpers";

// Area 11b: il brief del cliente nel Drive di VRD, una delle fonti fra cui
// Laura sceglie per la prima versione di Claude (la bozza lo cita con un
// blocco Drive in Overview). Caricato da Laura; nessuna apertura nel seme.

export const VRD_FILES: DriveFile[] = [
  upload(
    "VRD",
    1,
    {
      name: "Brief.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 164_880,
      by: "p-laura",
      at: at(9, "09:40"),
    },
    ready(
      "Brief from Palestra Verde Città: an app for members to book classes, show the membership at the desk and get reminders, released in phases with the spring launch.",
      "Client brief for the booking app.",
    ),
  ),
];
