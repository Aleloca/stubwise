import type { ComponentType } from "react";
import { useAutomations } from "../../../data/queries";
import type { HomeBlockKind, HomeBlockRef, Viewer } from "../../../data/types";
import { can } from "../../../data/viewer";
import { MyWeekBlock } from "../../week/MyWeekBlock";
import { AutomationsBlock } from "./AutomationsBlock";
import { ClaudeForMeBlock } from "./ClaudeForMeBlock";
import { DecideBlock } from "./DecideBlock";
import { FilterBlock } from "./FilterBlock";
import { ImportantMailBlock } from "./ImportantMailBlock";
import { MilestonesBlock } from "./MilestonesBlock";
import { MyTasksBlock } from "./MyTasksBlock";
import { NewRequestsBlock } from "./NewRequestsBlock";
import { StalledBlock } from "./StalledBlock";
import { UpcomingEventsBlock } from "./UpcomingEventsBlock";

export interface BlockDef {
  /** Il titolo del blocco (per `filter`, quello del catalogo: il blocco usa il nome del filtro). */
  titleKey: string;
  component: ComponentType<{ block: HomeBlockRef }>;
  /**
   * Se chi guarda può averlo: un blocco che richiede un permesso non è nel
   * catalogo di chi non ce l'ha. `ctx` porta ciò che dipende dai dati (vedi
   * `useBlockContext`).
   */
  available(viewer: Viewer, ctx?: BlockContext): boolean;
}

/** Ciò che serve sapere dai dati per decidere se un blocco c'è; `undefined` = ancora in lettura. */
export interface BlockContext {
  /** Chi guarda vede almeno un'automazione (blocco «Automations», [A 25]). */
  seesAutomations?: boolean;
}

/** Il contesto dei blocchi per chi guarda. */
export function useBlockContext(): BlockContext {
  const automations = useAutomations().data;
  return { seesAutomations: automations ? automations.length > 0 : undefined };
}

const always = () => true;

/**
 * Il catalogo dei blocchi della Home (spec §2), nell'ordine in cui il
 * catalogo li propone. I blocchi delle aree successive (canali, posta,
 * rilasci…) entrano qui con la loro area.
 */
export const BLOCKS: Record<HomeBlockKind, BlockDef> = {
  decide: { titleKey: "home.blocks.decide", component: DecideBlock, available: always },
  myWeek: { titleKey: "home.blocks.myWeek", component: MyWeekBlock, available: always },
  // Posta e Calendario (area 6): per tutti, senza permessi; senza account
  // Google il blocco c'è e lo dice.
  upcomingEvents: {
    titleKey: "home.blocks.upcomingEvents",
    component: UpcomingEventsBlock,
    available: always,
  },
  importantMail: {
    titleKey: "home.blocks.importantMail",
    component: ImportantMailBlock,
    available: always,
  },
  myTasks: { titleKey: "home.blocks.myTasks", component: MyTasksBlock, available: always },
  claudeForMe: {
    titleKey: "home.blocks.claudeForMe",
    component: ClaudeForMeBlock,
    available: always,
  },
  stalledInMyProjects: {
    titleKey: "home.blocks.stalledInMyProjects",
    component: StalledBlock,
    available: always,
  },
  newRequests: {
    titleKey: "home.blocks.newRequests",
    component: NewRequestsBlock,
    // Le richieste si trasformano in task: senza `tickets.create` in almeno un progetto non servono.
    available: (viewer) => can(viewer, "tickets.create"),
  },
  upcomingMilestones: {
    titleKey: "home.blocks.upcomingMilestones",
    component: MilestonesBlock,
    available: always,
  },
  // Le automazioni (area 7): nel catalogo di chi ne vede almeno una, mai
  // nelle Home di default [A 25]. Finché non si sa, un blocco già scelto resta.
  automations: {
    titleKey: "home.blocks.automations",
    component: AutomationsBlock,
    available: (_viewer, ctx) => ctx?.seesAutomations !== false,
  },
  filter: { titleKey: "home.blocks.filter", component: FilterBlock, available: always },
};

/** I tipi del catalogo «Add block» (i filtri si scelgono a parte, uno per uno). */
export const CATALOG_KINDS = (Object.keys(BLOCKS) as HomeBlockKind[]).filter((k) => k !== "filter");
