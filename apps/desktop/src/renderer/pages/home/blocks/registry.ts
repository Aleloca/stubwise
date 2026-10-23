import type { ComponentType } from "react";
import type { HomeBlockKind, HomeBlockRef, Viewer } from "../../../data/types";
import { can } from "../../../data/viewer";
import { MyWeekBlock } from "../../week/MyWeekBlock";
import { ClaudeForMeBlock } from "./ClaudeForMeBlock";
import { DecideBlock } from "./DecideBlock";
import { FilterBlock } from "./FilterBlock";
import { MilestonesBlock } from "./MilestonesBlock";
import { MyTasksBlock } from "./MyTasksBlock";
import { NewRequestsBlock } from "./NewRequestsBlock";
import { StalledBlock } from "./StalledBlock";

export interface BlockDef {
  /** Il titolo del blocco (per `filter`, quello del catalogo: il blocco usa il nome del filtro). */
  titleKey: string;
  component: ComponentType<{ block: HomeBlockRef }>;
  /** Se chi guarda può averlo: un blocco che richiede un permesso non è nel catalogo di chi non ce l'ha. */
  available(viewer: Viewer): boolean;
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
  filter: { titleKey: "home.blocks.filter", component: FilterBlock, available: always },
};

/** I tipi del catalogo «Add block» (i filtri si scelgono a parte, uno per uno). */
export const CATALOG_KINDS = (Object.keys(BLOCKS) as HomeBlockKind[]).filter((k) => k !== "filter");
