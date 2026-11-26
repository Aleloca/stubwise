import type { SupportWidget } from "../../types";
import { daysFromToday } from "../dates";

// Il widget del portale utenti di ACQ: da qui arrivano le conversazioni del
// canale «widget» (area 8a). Lo gestisce chi ha `widget.manage`. Dall'area 8,
// F3, anche quello di Audin (AUD-S1, l'esito è un ticket).

export const SUPPORT_WIDGETS: SupportWidget[] = [
  {
    id: "wdg-acq-portal",
    projectId: "prj-acq",
    name: "Customer portal help",
    enabled: true,
    // ACQ non ha repository: nessuna fonte della documentazione.
    sourceRepositoryIds: [],
    origins: ["https://portale.acquedottocolline.test"],
    title: "Help",
    welcomeMessage: "Hi! Tell us what you need: we read every message.",
    instructions: "",
    accentColor: "#0e7490",
    language: "it",
    dailyMessageCap: null,
    dailyRequestCap: null,
    // API per i siti (S6): il portale firma già i suoi clienti; il toggle è spento.
    identitySecretSet: true,
    identitySecretRotatedAt: `${daysFromToday(-12)}T15:20:00Z`,
    identityRequired: false,
    createdAt: `${daysFromToday(-40)}T09:00:00Z`,
  },
  // Area 8, F3: il widget di Audin, da cui è arrivata AUD-S1 (il ticket AUD-6).
  {
    id: "wdg-aud-help",
    projectId: "prj-aud",
    name: "Audin help (fake)",
    enabled: true,
    sourceRepositoryIds: [],
    origins: ["https://app.audin.test"],
    title: "Help",
    welcomeMessage: "Hi! How can we help?",
    instructions: "",
    accentColor: "#4f46e5",
    language: "en",
    dailyMessageCap: null,
    dailyRequestCap: null,
    identitySecretSet: false,
    identitySecretRotatedAt: null,
    identityRequired: false,
    createdAt: `${daysFromToday(-60)}T09:00:00Z`,
  },
];
