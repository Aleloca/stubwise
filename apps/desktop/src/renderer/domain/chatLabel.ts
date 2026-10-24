// Il nome di un canale della Chat, in UN posto: lo leggono il livello dati
// (le etichette di «Da decidere» e delle notifiche) e la UI (testata,
// colonna, ricerca, «Browse channels»). Di progetto «AUD · general» (il
// codice tabellare, poi il nome), generale «# announcements», un DM i nomi
// degli altri partecipanti.

export interface ChannelName {
  /** Il codice del progetto, «#» per un generale, `null` per un DM. */
  code: string | null;
  /** Il nome senza il codice (per un DM, i nomi degli altri). */
  name: string;
  /** Ciò che precede il nome: «AUD · », «# », niente per un DM. */
  prefix: string;
  /** Tutto insieme: `prefix + name`. */
  label: string;
}

export interface ChannelNameSource {
  kind: "project" | "general" | "dm";
  name: string;
  projectId: string | null;
  memberIds: readonly string[];
}

const PROJECT_SEPARATOR = " · ";

export function channelName(
  ch: ChannelNameSource,
  me: string,
  codeOf: (projectId: string) => string | undefined,
  nameOf: (personId: string) => string | undefined,
): ChannelName {
  if (ch.kind === "project") {
    const code = (ch.projectId !== null ? codeOf(ch.projectId) : undefined) ?? "";
    return named(code, `${code}${PROJECT_SEPARATOR}`, ch.name);
  }
  if (ch.kind === "general") return named("#", "# ", ch.name);
  const names = ch.memberIds
    .filter((id) => id !== me)
    .map((id) => nameOf(id) ?? "")
    .join(", ");
  return named(null, "", names);
}

/** Un'etichetta già composta (da `channelName`), di nuovo nei suoi pezzi. */
export function splitChannelLabel(label: string): ChannelName {
  const at = label.indexOf(PROJECT_SEPARATOR);
  if (at > 0 && !label.slice(0, at).includes(" ")) {
    const code = label.slice(0, at);
    return named(code, `${code}${PROJECT_SEPARATOR}`, label.slice(at + PROJECT_SEPARATOR.length));
  }
  if (label.startsWith("# ")) return named("#", "# ", label.slice(2));
  return named(null, "", label);
}

const named = (code: string | null, prefix: string, name: string): ChannelName => ({
  code,
  name,
  prefix,
  label: `${prefix}${name}`,
});
