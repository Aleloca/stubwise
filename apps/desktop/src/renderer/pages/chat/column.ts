import type { ChannelRow, Project } from "../../data/types";

// La colonna della Chat come dato: i canali in cui la persona è, raggruppati
// per progetto (prima i fissati nel binario, nel loro ordine, poi gli altri
// per codice), poi i generali dell'azienda, poi i messaggi diretti. I
// progetti né fissati né con qualcosa di nuovo stanno in `quiet`, che la
// colonna raccoglie in una riga chiusa «Other projects · N» (approvato dal
// maintainer il 24 ott 2026: così i diretti restano sopra la piega). Un
// archiviato non c'è (si raggiunge da Browse e dalla ricerca); un privato
// che si gestisce senza esserne membro nemmeno. Lo stesso ordine serve a
// ⌥↑/⌥↓ e ⌥⇧↑/⌥⇧↓. Qui anche ciò che la colonna ricorda per persona: i
// gruppi aperti o chiusi e l'ultimo canale aperto (l'atterraggio di `/chat`).

export interface ProjectGroup {
  project: Project;
  channels: ChannelRow[];
  unread: number;
  mentions: number;
}

export interface ChatColumnModel {
  /** I progetti in vista: fissati, o con non letti o menzioni. */
  projects: ProjectGroup[];
  /** Gli altri: nella riga chiusa «Other projects · N». */
  quiet: ProjectGroup[];
  company: ChannelRow[];
  dms: ChannelRow[];
}

/** I canali di un gruppo: il «general» prima, poi per nome. */
const byGeneralThenName = (a: ChannelRow, b: ChannelRow) =>
  Number(b.isGeneral) - Number(a.isGeneral) || a.name.localeCompare(b.name);

/** Nella colonna: i canali in cui la persona è, non archiviati. */
export const inColumn = (row: ChannelRow): boolean => row.isMember && !row.archived;

export function chatColumnModel(
  rows: readonly ChannelRow[],
  projects: readonly Project[],
  pinnedIds: readonly string[],
  /** Il canale aperto: il suo progetto resta in vista (non sparisce mai dalla colonna). */
  currentId?: string,
): ChatColumnModel {
  const mine = rows.filter(inColumn);
  const byProject = new Map<string, ChannelRow[]>();
  for (const row of mine) {
    if (row.kind !== "project" || row.projectId === null) continue;
    const list = byProject.get(row.projectId) ?? [];
    list.push(row);
    byProject.set(row.projectId, list);
  }
  const rank = (p: Project) => {
    const i = pinnedIds.indexOf(p.id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const groups = projects
    .filter((p) => byProject.has(p.id))
    .sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
    .map((project): ProjectGroup => {
      const channels = byProject.get(project.id)!.sort(byGeneralThenName);
      return {
        project,
        channels,
        unread: channels.reduce((n, c) => n + c.unread, 0),
        mentions: channels.reduce((n, c) => n + c.mentions, 0),
      };
    });
  const company = mine
    .filter((r) => r.kind === "general")
    .sort((a, b) => a.name.localeCompare(b.name));
  // I messaggi diretti: dal più recente; senza messaggi, dalla nascita.
  const last = (r: ChannelRow) => r.lastActivityAt ?? r.createdAt;
  const dms = mine.filter((r) => r.kind === "dm").sort((a, b) => last(b).localeCompare(last(a)));
  const listed = (g: ProjectGroup) =>
    pinnedIds.includes(g.project.id) ||
    g.channels.some(hasNews) ||
    g.channels.some((c) => c.id === currentId);
  return {
    projects: groups.filter(listed),
    quiet: groups.filter((g) => !listed(g)),
    company,
    dms,
  };
}

/** L'ordine della colonna, per la tastiera: progetti (in vista, poi gli altri), azienda, diretti. */
export function columnOrder(model: ChatColumnModel): ChannelRow[] {
  return [
    ...[...model.projects, ...model.quiet].flatMap((g) => g.channels),
    ...model.company,
    ...model.dms,
  ];
}

/**
 * Il canale chiede attenzione: non letti o menzioni, mai da silenziato (non
 * diventa grassetto, non apre il suo gruppo, ⌥⇧↑/⌥⇧↓ lo saltano).
 */
export const hasNews = (row: ChannelRow): boolean =>
  row.notifyLevel !== "muted" && (row.unread > 0 || row.mentions > 0);

// --- ciò che la colonna ricorda, per persona ---------------------------------
//
// In memoria e, se c'è, in `localStorage`: una preferenza di comodo, che può
// sparire senza danni (finestra privata, dati cancellati).

const memory = new Map<string, string>();
const PREFIX = "stubwise.chat.";

function read(key: string): string | null {
  try {
    const stored = window.localStorage.getItem(PREFIX + key);
    if (stored !== null) return stored;
  } catch {
    // Senza localStorage resta la memoria.
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Idem.
  }
}

/** L'ultimo canale aperto dalla persona (`null` la prima volta). */
export const lastChannelOf = (personId: string): string | null => read(`last.${personId}`);

export const rememberLastChannel = (personId: string, channelId: string): void =>
  write(`last.${personId}`, channelId);

/**
 * Aperto o chiuso, scelto a mano, per un gruppo di progetto: `undefined` se
 * la persona non l'ha mai toccato (allora decide la colonna: aperto solo
 * con qualcosa di non letto).
 */
export function groupOpenOf(personId: string, projectId: string): boolean | undefined {
  const value = read(`group.${personId}.${projectId}`);
  return value === null ? undefined : value === "1";
}

export const rememberGroupOpen = (personId: string, projectId: string, open: boolean): void =>
  write(`group.${personId}.${projectId}`, open ? "1" : "0");

// Le ultime ricerche della Chat (shape chat-search.md §5, §7): solo su questo
// dispositivo, di una persona sola — chi le legge da un'altra persona le
// trova vuote e le cancella (cambio di persona).

const RECENT = "recentSearches";
/** Quante ricerche recenti si tengono. */
export const RECENT_LIMIT = 5;

export function recentSearchesOf(personId: string): string[] {
  const raw = read(RECENT);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as { personId?: unknown; items?: unknown };
    if (parsed.personId === personId && Array.isArray(parsed.items)) {
      return parsed.items.filter((q): q is string => typeof q === "string").slice(0, RECENT_LIMIT);
    }
  } catch {
    // Un valore rotto vale come nessuno.
  }
  write(RECENT, null);
  return [];
}

export function rememberSearch(personId: string, q: string): void {
  const text = q.trim();
  if (text.length < 2) return;
  const items = [
    text,
    ...recentSearchesOf(personId).filter((x) => x.toLowerCase() !== text.toLowerCase()),
  ].slice(0, RECENT_LIMIT);
  write(RECENT, JSON.stringify({ personId, items }));
}

export const clearRecentSearches = (): void => write(RECENT, null);

/** Dimentica tutto (test, reset del prototipo). */
export function clearChatColumnPrefs(): void {
  memory.clear();
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Idem.
  }
}
