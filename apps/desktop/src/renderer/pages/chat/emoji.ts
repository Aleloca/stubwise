// L'elenco fisso del selettore delle reazioni: emoji Unicode per categoria,
// ognuna con le parole (inglesi) che la ritrovano nella ricerca. Nessun
// set personalizzato nel prototipo.

export interface EmojiCategory {
  id: "people" | "gestures" | "work" | "nature" | "food" | "symbols";
  items: [emoji: string, words: string][];
}

export const EMOJI: EmojiCategory[] = [
  {
    id: "people",
    items: [
      ["😀", "grin smile happy"],
      ["😄", "smile laugh"],
      ["😂", "joy laugh tears"],
      ["🙂", "slight smile"],
      ["😉", "wink"],
      ["😍", "love heart eyes"],
      ["🤔", "thinking hmm"],
      ["😅", "sweat smile relief"],
      ["😬", "grimace awkward"],
      ["😮", "surprised wow"],
      ["😢", "sad cry"],
      ["😴", "sleep tired"],
      ["🤯", "mind blown"],
      ["🥳", "party celebrate"],
      ["😎", "cool sunglasses"],
      ["🫠", "melting"],
    ],
  },
  {
    id: "gestures",
    items: [
      ["👍", "thumbs up yes ok +1"],
      ["👎", "thumbs down no -1"],
      ["👏", "clap applause"],
      ["🙌", "raised hands hooray"],
      ["🙏", "thanks please pray"],
      ["👋", "wave hello hi"],
      ["💪", "strong muscle"],
      ["🤝", "handshake deal"],
      ["✌️", "peace victory"],
      ["👀", "eyes looking"],
      ["🫡", "salute"],
      ["🤞", "fingers crossed luck"],
    ],
  },
  {
    id: "work",
    items: [
      ["✅", "check done yes"],
      ["☑️", "checkbox done"],
      ["❌", "cross no wrong"],
      ["⚠️", "warning caution"],
      ["🚀", "rocket launch ship"],
      ["🐛", "bug"],
      ["🔥", "fire hot"],
      ["💡", "idea bulb"],
      ["📌", "pin"],
      ["📎", "paperclip attach"],
      ["📈", "chart up growth"],
      ["📉", "chart down"],
      ["🗓️", "calendar date"],
      ["⏳", "hourglass waiting"],
      ["🔒", "lock private"],
      ["🧪", "test experiment"],
      ["🛠️", "tools fix"],
      ["📝", "memo note write"],
      ["📣", "announce megaphone"],
      ["🎯", "target goal"],
    ],
  },
  {
    id: "nature",
    items: [
      ["🌱", "seedling grow"],
      ["🌞", "sun"],
      ["🌧️", "rain"],
      ["⚡", "lightning fast"],
      ["❄️", "snow cold"],
      ["🌈", "rainbow"],
      ["🐢", "turtle slow"],
      ["🐙", "octopus"],
    ],
  },
  {
    id: "food",
    items: [
      ["☕", "coffee"],
      ["🍕", "pizza"],
      ["🍰", "cake"],
      ["🍾", "champagne celebrate"],
      ["🍋", "lemon"],
      ["🥐", "croissant"],
    ],
  },
  {
    id: "symbols",
    items: [
      ["❤️", "heart love"],
      ["💯", "hundred perfect"],
      ["➕", "plus add"],
      ["❓", "question"],
      ["❗", "exclamation"],
      ["⭐", "star"],
      ["✨", "sparkles"],
      ["🎉", "tada party celebrate"],
      ["🏁", "finish flag"],
      ["🔁", "repeat again"],
      ["🆗", "ok"],
      ["🆕", "new"],
    ],
  },
];

/** Le reazioni rapide quando chi guarda non ha ancora reagito a nulla qui. */
export const DEFAULT_QUICK = ["👍", "✅", "👀", "🎉", "🙏", "😂"];

/** Le 6 più usate da chi guarda nel flusso letto, poi le predefinite. */
export function mostUsed(
  reactions: readonly { emoji: string; personIds: readonly string[] }[],
  viewerId: string,
  count = 6,
): string[] {
  const tally = new Map<string, number>();
  for (const r of reactions) {
    if (r.personIds.includes(viewerId)) tally.set(r.emoji, (tally.get(r.emoji) ?? 0) + 1);
  }
  const used = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  return [...new Set([...used, ...DEFAULT_QUICK])].slice(0, count);
}

/** Le emoji che corrispondono alla ricerca (parole che iniziano così). */
export function searchEmoji(q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return EMOJI.flatMap((c) => c.items)
    .filter(([, words]) => words.split(" ").some((w) => w.startsWith(needle)))
    .map(([e]) => e);
}
