import type { SupportWidget } from "../../types";
import { daysFromToday } from "../dates";

// Il widget del portale utenti di ACQ: da qui arrivano le conversazioni del
// canale «widget» (area 8a). Lo gestisce chi ha `widget.manage`.

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
    createdAt: `${daysFromToday(-40)}T09:00:00Z`,
  },
];
