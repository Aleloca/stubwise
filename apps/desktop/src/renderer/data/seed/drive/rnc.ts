import type { DriveFile } from "../../types";
import { at, ready, upload } from "./helpers";

// Area 9c: i tre file di RNC, il progetto archiviato. Caricati prima
// dell'archiviazione (28 giorni fa); nessuna apertura dopo.

export const RNC_FILES: DriveFile[] = [
  upload(
    "RNC",
    1,
    {
      name: "listino-vini-2026.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 412_880,
      by: "p-elena",
      at: at(60, "11:10"),
    },
    ready(
      "Wine list 2026: reds, whites and the late harvest, with bottle and case prices.",
      "Wine list 2026 with bottle and case prices.",
    ),
  ),
  upload(
    "RNC",
    2,
    {
      name: "foto-cantina.jpg",
      type: "image",
      mime: "image/jpeg",
      sizeBytes: 2_904_331,
      by: "p-giulia",
      at: at(55, "15:40"),
    },
    ready("The cellar with the oak barrels, morning light.", "Photo of the cellar."),
  ),
  upload(
    "RNC",
    3,
    {
      name: "testi-homepage.docx",
      type: "document",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 38_204,
      by: "p-giulia",
      at: at(48, "09:25"),
    },
    ready(
      "Homepage copy: the estate story, the wines, the farm stay and how to book.",
      "Homepage copy: estate, wines, farm stay.",
    ),
  ),
];
