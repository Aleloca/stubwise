import type { DriveFile, DriveOpen } from "../../types";
import { ROADMAP_Q4_GOOGLE_ID } from "./aud";
import { STW_BRAND_FOLDER as F } from "./google";
import { at, google, ready, spread, upload } from "./helpers";

// Stubwise: pochi file. La roadmap Q4 è lo stesso file Google di AUD-F5
// (due riferimenti, due codici, conteggi separati); la cartella del brand
// l'ha collegata Laura, il cui account Google è scaduto.

const LAURA = "laura.costa@example.com";

export const STW_FILES: DriveFile[] = [
  google(
    "STW",
    1,
    { by: "p-giulia", at: at(38, "09:20") },
    {
      name: "Roadmap Q4 2026",
      type: "sheet",
      googleFileId: ROADMAP_Q4_GOOGLE_ID,
      owner: "giulia.ferri@example.com",
      modified: at(3, "17:15"),
    },
    ready(
      "Q4 2026 roadmap. October: dialer callbacks, pricing page. November: CRM import, billing beta. December: Stubwise release queue, Audin 2.0 launch.",
      "Q4 2026 roadmap shared by Audin and Stubwise: dialer, CRM import, billing, launch.",
    ),
  ),
  google(
    "STW",
    2,
    F,
    {
      name: "Logo Stubwise – varianti.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 3_408_220,
      googleFileId: "gfile-stw-logo-varianti",
      owner: LAURA,
      modified: at(74, "10:00"),
    },
    ready(
      "Stubwise logo variants: full colour, monochrome, dark background, favicon. Minimum size 24 px.",
      "Logo variants and minimum sizes.",
    ),
  ),
  google(
    "STW",
    3,
    F,
    {
      name: "Stubwise pitch deck",
      type: "slides",
      googleFileId: "gfile-stw-pitch",
      owner: LAURA,
      modified: at(48, "15:30"),
    },
    ready(
      "Stubwise: tickets fixed by an AI pipeline, docs generated from the repositories, self-hosted. Pricing, roadmap, team.",
      "Pitch deck: the AI pipeline, generated docs, self-hosting, pricing.",
    ),
  ),
  upload(
    "STW",
    4,
    {
      name: "architettura-worker.png",
      type: "image",
      mime: "image/png",
      sizeBytes: 198_450,
      by: "p-marco",
      at: at(22, "11:45"),
    },
    ready(
      "Worker: job queue (FOR UPDATE SKIP LOCKED) → per-project serializer → claude CLI → PR.",
      "Diagram of the worker: job queue, per-project serializer, agent, PR.",
    ),
  ),
];

export const STW_OPENS: DriveOpen[] = [
  ...spread("drv-stw-1", ["p-laura", "p-marco"], 2, 20, 4, "google"),
  ...spread("drv-stw-3", ["p-laura", "p-giulia", "p-sara"], 3, 45, 15, "google"),
  ...spread("drv-stw-4", ["p-marco", "p-simone"], 4, 20, 2, "preview"),
];
