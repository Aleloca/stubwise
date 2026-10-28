import type { SupportWidget } from "../../types";
import { daysFromToday } from "../dates";

// Il widget del portale utenti di ACQ: da qui arrivano le conversazioni del
// canale «widget» (area 8a). Lo gestisce chi ha `widget.manage`.

export const SUPPORT_WIDGETS: SupportWidget[] = [
  {
    id: "wdg-acq-portal",
    projectId: "prj-acq",
    name: "Customer portal help",
    origins: ["https://portale.acquedottocolline.test"],
    greeting: "Hi! Tell us what you need: we read every message.",
    createdAt: `${daysFromToday(-40)}T09:00:00Z`,
  },
];
