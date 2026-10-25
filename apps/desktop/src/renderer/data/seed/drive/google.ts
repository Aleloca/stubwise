import type { FolderLink, GoogleAccount, GoogleOutsideFile } from "../../types";
import { at } from "./helpers";

// Google è tutto simulato. Fra le persone del «vedi come»: Giulia ha
// l'account collegato, Laura scaduto (e con lui la cartella che ha collegato
// in STW), Marco, Sara e Roberta non l'hanno. Matteo, che ha collegato la
// cartella del cliente di AUD, è collegato.
export const GOOGLE_ACCOUNTS: GoogleAccount[] = [
  { personId: "p-giulia", email: "giulia.ferri@example.com", status: "connected" },
  { personId: "p-matteo", email: "matteo.conti@example.com", status: "connected" },
  { personId: "p-laura", email: "laura.costa@example.com", status: "expired" },
];

export const AUD_CLIENT_FOLDER: FolderLink = {
  id: "fl-aud-cliente",
  projectId: "prj-aud",
  name: "AUD – Cliente",
  googleFolderId: "gfolder-aud-cliente",
  linkedById: "p-matteo",
  linkedAt: at(140, "10:05"),
  status: "ok",
};

export const MKX_CAMPAIGN_FOLDER: FolderLink = {
  id: "fl-mkx-primavera",
  projectId: "prj-mkx",
  name: "MKX – Campagna primavera",
  googleFolderId: "gfolder-mkx-primavera",
  linkedById: "p-giulia",
  linkedAt: at(120, "09:30"),
  status: "ok",
};

/** Collegata da Laura, il cui account è scaduto: chi gestisce il Drive di STW vede «Ricollega». */
export const STW_BRAND_FOLDER: FolderLink = {
  id: "fl-stw-brand",
  projectId: "prj-stw",
  name: "STW – Brand assets",
  googleFolderId: "gfolder-stw-brand",
  linkedById: "p-laura",
  linkedAt: at(75, "16:20"),
  status: "expired",
};

export const FOLDER_LINKS: FolderLink[] = [
  AUD_CLIENT_FOLDER,
  MKX_CAMPAIGN_FOLDER,
  STW_BRAND_FOLDER,
];

/**
 * File di Google Drive in nessun progetto: li trova dalla ricerca solo chi
 * ha l'account collegato e li vede su Google (per provare «a quale progetto?»).
 */
export const GOOGLE_OUTSIDE_FILES: GoogleOutsideFile[] = [
  {
    googleFileId: "gfile-out-bellavista-offer",
    name: "Offerta Cantina Bellavista – bozza",
    type: "document",
    visibleToPersonIds: ["p-giulia", "p-matteo"],
    text: "Draft offer for Cantina Bellavista: online store with wine club subscriptions, shipping rules by region and a tasting-room booking page. Estimated effort 45 working days; first release 30 working days after the kickoff.",
    summary:
      "Draft offer for the Cantina Bellavista online store: wine club, shipping by region, tasting bookings.",
  },
  {
    googleFileId: "gfile-out-moodboard-autunno",
    name: "Moodboard autunno 2026",
    type: "slides",
    visibleToPersonIds: ["p-giulia"],
    text: "Autumn 2026 moodboard: warm ochre and burgundy palette, wood textures, hand-written headlines, kitchen scenes in natural light.",
    summary: "Autumn 2026 moodboard: ochre and burgundy palette, wood textures, natural light.",
  },
];
