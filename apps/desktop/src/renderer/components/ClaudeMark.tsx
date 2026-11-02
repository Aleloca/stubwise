// Il segno «fatto con Claude» (area 10a, shape claude-trace.md [CT 2]):
// l'anello tratteggiato FERMO da 12px. Quello che pulsa (`WorkingRing`) dice
// «Claude sta lavorando»; questo dice che una cosa l'ha fatta Claude per
// qualcuno. Ha sempre il testo accanto o, con `label`, il nome per chi non
// vede (e il `title` al passaggio).

export function ClaudeMark({ label }: { label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      data-claude-mark
      className="inline-block size-3 shrink-0 rounded-full border-[1.5px] border-dashed border-claude"
    />
  );
}
