import type { DriveFile } from "../../types";
import { at, ready, upload } from "./helpers";

// Area 11a: il file di ACQ che la doc di prodotto cita (il blocco Drive di
// Overview). Caricato da Laura; nessuna apertura nel seme.

export const ACQ_FILES: DriveFile[] = [
  upload(
    "ACQ",
    1,
    {
      name: "Client brief.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 286_420,
      by: "p-laura",
      at: at(34, "10:15"),
    },
    ready(
      "Brief from the water utility: the portal for bills, readings and fault reports, with the phases and the people involved.",
      "Client brief for the customer portal.",
    ),
  ),
];
