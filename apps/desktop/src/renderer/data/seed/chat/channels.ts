import type { Channel, ChatEventKind } from "../../types";
import { PEOPLE } from "../people";
import { PROJECTS } from "../projects";
import { at } from "./helpers";

// I canali della Chat: un «general» per ogni progetto (tutti i suoi membri,
// Claude escluso: si chiama con «@Claude», non legge né ha non letti),
// qualche canale tematico nei tre progetti di riferimento, i canali
// generali dell'azienda e i messaggi diretti.

const HUMANS = PEOPLE.filter((p) => !p.isClaude).map((p) => p.id);

/** I membri di un progetto che leggono la Chat (Claude escluso). */
export function chatMembersOf(projectId: string): string[] {
  const project = PROJECTS.find((p) => p.id === projectId)!;
  return project.memberIds.filter((id) => HUMANS.includes(id));
}

/** Gli eventi pubblicati di base in un canale di progetto: Release, traguardi, brief. */
export const DEFAULT_PUBLISHED_EVENTS: ChatEventKind[] = [
  "release_page",
  "milestone_reached",
  "brief_ready",
];

/** Eventi diversi dal default, per i «general» dei progetti di riferimento. */
const GENERAL_EVENTS: Record<string, ChatEventKind[]> = {
  // AUD pubblica le Release e le PR in «releases».
  AUD: ["milestone_reached", "brief_ready", "request_new"],
  STW: ["release_page", "milestone_reached", "brief_ready", "task_closed"],
  MKX: ["milestone_reached", "brief_ready", "request_new", "task_closed"],
};

/** Il creatore di un «general»: il primo Project Lead fra i membri, se no il primo membro. */
const LEADS = ["p-laura", "p-giulia", "p-matteo"];

const generals: Channel[] = PROJECTS.map((p) => {
  const members = chatMembersOf(p.id);
  return {
    id: `ch-${p.code.toLowerCase()}-general`,
    kind: "project",
    projectId: p.id,
    name: "general",
    description: `Everything about ${p.name}.`,
    topic: "",
    visibility: "open",
    createdById: LEADS.find((id) => members.includes(id)) ?? members[0]!,
    archived: false,
    archivedById: null,
    archivedAt: null,
    isGeneral: true,
    memberIds: members,
    publishedEvents: GENERAL_EVENTS[p.code] ?? [...DEFAULT_PUBLISHED_EVENTS],
    createdAt: at(60, "08:00"),
  };
});

type Extra = Pick<Channel, "id" | "name" | "createdById" | "memberIds" | "createdAt"> &
  Partial<Channel>;

function projectChannel(code: string, extra: Extra): Channel {
  return {
    kind: "project",
    projectId: `prj-${code.toLowerCase()}`,
    description: "",
    topic: "",
    visibility: "open",
    archived: false,
    archivedById: null,
    archivedAt: null,
    isGeneral: false,
    publishedEvents: [],
    ...extra,
  };
}

function generalChannel(extra: Extra): Channel {
  return {
    kind: "general",
    projectId: null,
    description: "",
    topic: "",
    visibility: "open",
    archived: false,
    archivedById: null,
    archivedAt: null,
    isGeneral: false,
    publishedEvents: [],
    ...extra,
  };
}

function dm(id: string, memberIds: string[], createdAt: string): Channel {
  return {
    id,
    kind: "dm",
    projectId: null,
    name: "",
    description: "",
    topic: "",
    visibility: "private",
    createdById: memberIds[0]!,
    archived: false,
    archivedById: null,
    archivedAt: null,
    isGeneral: false,
    memberIds,
    publishedEvents: [],
    createdAt,
  };
}

const thematic: Channel[] = [
  projectChannel("AUD", {
    id: "ch-aud-releases",
    name: "releases",
    description: "Release pages and pull requests of Audin 2.0.",
    topic: "Public launch: release 1.0 in four weeks",
    createdById: "p-laura",
    memberIds: ["p-laura", "p-marco", "p-stefano", "p-alessia", "p-matteo"],
    publishedEvents: ["release_page", "pr_opened", "pr_merged"],
    createdAt: at(40, "09:30"),
  }),
  // Privato di progetto: Roberta (full admin) ne vede nome e membri, mai i messaggi.
  projectChannel("AUD", {
    id: "ch-aud-pricing",
    name: "pricing",
    description: "Prices and discounts before they are public.",
    visibility: "private",
    createdById: "p-matteo",
    memberIds: ["p-matteo", "p-laura", "p-elena"],
    createdAt: at(30, "11:00"),
  }),
  projectChannel("STW", {
    id: "ch-stw-desktop",
    name: "desktop-app",
    description: "The desktop prototype: design, builds and reviews.",
    topic: "Demo on Friday at 16:00",
    createdById: "p-laura",
    memberIds: ["p-laura", "p-marco", "p-simone", "p-federico", "p-giulia"],
    publishedEvents: ["pr_opened", "pr_merged"],
    createdAt: at(35, "10:00"),
  }),
  projectChannel("MKX", {
    id: "ch-mkx-grafica",
    name: "grafica",
    description: "Creatives, photos and layouts for Mix Cucine.",
    createdById: "p-giulia",
    memberIds: ["p-giulia", "p-chiara", "p-tommaso", "p-elena", "p-paolo"],
    createdAt: at(32, "09:15"),
  }),
  projectChannel("MKX", {
    id: "ch-mkx-autumn",
    name: "autumn-campaign",
    description: "Last year's autumn campaign. Archived when it ended.",
    createdById: "p-paolo",
    memberIds: ["p-paolo", "p-giulia", "p-elena"],
    archived: true,
    archivedById: "p-paolo",
    archivedAt: at(45, "17:30"),
    createdAt: at(80, "09:00"),
  }),
];

const companyGenerals: Channel[] = [
  generalChannel({
    id: "ch-announcements",
    name: "announcements",
    description: "Company news. Everyone is in.",
    topic: "Q4 all-hands next Thursday at 10:00",
    createdById: "p-roberta",
    memberIds: [...HUMANS],
    createdAt: at(60, "08:00"),
  }),
  generalChannel({
    id: "ch-marketing",
    name: "marketing",
    description: "Campaigns, brand and press across clients.",
    createdById: "p-giulia",
    memberIds: [
      "p-giulia",
      "p-elena",
      "p-paolo",
      "p-chiara",
      "p-tommaso",
      "p-matteo",
      "p-francesca",
    ],
    createdAt: at(60, "08:30"),
  }),
  generalChannel({
    id: "ch-chit-chat",
    name: "chit-chat",
    description: "Lunch, coffee and everything else.",
    createdById: "p-federico",
    memberIds: HUMANS.filter((id) => !["p-andrea", "p-silvia", "p-enrico"].includes(id)),
    createdAt: at(60, "09:00"),
  }),
];

const dms: Channel[] = [
  dm("dm-giulia-marco", ["p-giulia", "p-marco"], at(30, "10:00")),
  dm("dm-giulia-laura", ["p-giulia", "p-laura"], at(25, "10:00")),
  dm("dm-laura-marco", ["p-laura", "p-marco"], at(25, "11:00")),
  dm("dm-giulia-roberta", ["p-roberta", "p-giulia"], at(20, "09:00")),
  dm("dm-davide-sara", ["p-sara", "p-davide"], at(20, "09:30")),
  // Gruppo (≤ 8) senza Roberta: per lei non esiste.
  dm("dm-launch-week", ["p-laura", "p-giulia", "p-marco", "p-sara", "p-elena"], at(7, "09:00")),
];

export const CHAT_CHANNELS: Channel[] = [...generals, ...thematic, ...companyGenerals, ...dms];
