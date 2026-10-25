import type { DriveFile, DriveOpen } from "../../types";
import { MKX_CAMPAIGN_FOLDER as F } from "./google";
import { at, google, ready, spread, upload } from "./helpers";

// Campagne primavera Mix Cucine: tanti file grafici. La cartella della
// campagna collegata da Giulia (visual, banner e post, quasi tutti
// immagini) e i caricati del team (il brief, qualche scatto).

const GIULIA = "giulia.ferri@example.com";

/** [nome, testo nell'immagine (vuoto = nessun testo), giorni fa dell'ultima modifica]. */
const VISUALS: [string, string, number][] = [
  ["KV primavera – orizzontale.jpg", "Spring in your kitchen. Mix Cucine, from March.", 18],
  ["KV primavera – verticale.jpg", "Spring in your kitchen. Mix Cucine, from March.", 18],
  ["Banner 728x90 – cucine moderne.png", "Modern kitchens from €4,900. Discover more.", 22],
  ["Banner 300x250 – cucine moderne.png", "Modern kitchens from €4,900.", 22],
  ["Banner 160x600 – showroom.png", "Visit our showroom. Book a visit.", 25],
  ["Post Instagram 01 – isola.jpg", "The island, at the heart of the home.", 30],
  ["Post Instagram 02 – dettagli legno.jpg", "", 30],
  ["Post Instagram 03 – colori pastello.jpg", "Pastel colours for spring.", 31],
  ["Post Instagram 04 – piano in quarzo.jpg", "", 31],
  ["Post Instagram 05 – prima e dopo.jpg", "Before / After", 33],
  ["Story 01 – countdown.png", "3 days to go", 34],
  ["Story 02 – countdown.png", "2 days to go", 34],
  ["Story 03 – countdown.png", "Tomorrow", 34],
  ["Copertina Facebook – primavera.jpg", "Mix Cucine · Spring collection", 40],
  ["Volantino A5 fronte.png", "Spring open days, 14–16 March. Mix Cucine showroom.", 42],
  ["Volantino A5 retro.png", "Map and opening hours.", 42],
  ["Foto showroom 01.jpg", "", 60],
  ["Foto showroom 02.jpg", "", 60],
  ["Foto showroom 03.jpg", "", 60],
  ["Foto cucina Rovere naturale.jpg", "", 65],
  ["Foto cucina Bianco opaco.jpg", "", 65],
  ["Foto cucina Verde salvia.jpg", "", 66],
  ["Newsletter header – marzo.png", "March news from Mix Cucine", 70],
  ["Logo campagna – variante chiara.png", "Spring with Mix Cucine", 90],
];

const visuals: DriveFile[] = VISUALS.map(([name, text, days], i) =>
  google(
    "MKX",
    i + 2,
    F,
    {
      name,
      type: "image",
      mime: name.endsWith(".png") ? "image/png" : "image/jpeg",
      sizeBytes: 240_000 + ((i * 97_331) % 2_600_000),
      googleFileId: `gfile-mkx-visual-${i + 1}`,
      owner: GIULIA,
      modified: at(days, "11:00"),
    },
    text ? ready(text, `Campaign visual: “${text}”`) : { content: "no_text" },
  ),
);

export const MKX_FILES: DriveFile[] = [
  upload(
    "MKX",
    1,
    {
      name: "Brief campagna primavera Mix Cucine.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 1_532_004,
      by: "p-giulia",
      at: at(118, "10:00"),
    },
    ready(
      "Spring campaign brief for Mix Cucine. Goal: 300 showroom bookings between March and May. Channels: Instagram, Facebook, display banners, newsletter. Tone: warm, light, family kitchens. Budget €18,000.",
      "Spring campaign brief: 300 showroom bookings, social and display, budget €18,000.",
    ),
  ),
  ...visuals,
  upload(
    "MKX",
    26,
    {
      name: "scatto-set-fotografico-01.jpg",
      type: "image",
      mime: "image/jpeg",
      sizeBytes: 6_204_118,
      by: "p-chiara",
      at: at(28, "16:40"),
    },
    { content: "no_text" },
  ),
  upload(
    "MKX",
    27,
    {
      name: "scatto-set-fotografico-02.jpg",
      type: "image",
      mime: "image/jpeg",
      sizeBytes: 5_980_532,
      by: "p-chiara",
      at: at(28, "16:41"),
    },
    { content: "no_text" },
  ),
  upload(
    "MKX",
    28,
    {
      name: "Report risultati marzo.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 820_077,
      by: "p-tommaso",
      at: at(8, "09:30"),
    },
    ready(
      "March results: 112 showroom bookings (target 100), cost per booking €41, best visual: KV primavera – verticale.",
      "March results: 112 showroom bookings, €41 per booking.",
    ),
  ),
];

const TEAM = ["p-giulia", "p-chiara", "p-tommaso", "p-paolo", "p-elena", "p-francesca"];

export const MKX_OPENS: DriveOpen[] = [
  ...spread("drv-mkx-1", TEAM, 12, 115, 10, ["preview", "download"]),
  ...spread("drv-mkx-3", TEAM, 15, 85, 2, "google"),
  ...spread("drv-mkx-2", ["p-giulia", "p-chiara", "p-tommaso"], 9, 80, 5, "google"),
  ...spread("drv-mkx-4", ["p-giulia", "p-paolo"], 6, 60, 10, "google"),
  ...spread("drv-mkx-7", ["p-chiara"], 2, 40, 20, "google"),
  ...spread("drv-mkx-12", ["p-tommaso"], 1, 33, 33, "google"),
  ...spread("drv-mkx-28", ["p-giulia", "p-matteo", "p-tommaso"], 4, 7, 1, "preview"),
];
