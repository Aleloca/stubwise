import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProductPresence } from "../../../data/queries";
import type { ProductBlock, ProductPageView, ProductPresenceView } from "../../../data/types";
import { isTextBlock } from "../../../domain/productDocs/blocks";
import { sectionOf } from "../../../domain/productDocs/sections";
import { presenceColor } from "./presenceColor";

// Chi c'è nella pagina, nella barra dello spazio dopo lo stato di
// salvataggio (shape product-editor.md §3.13, [PE 16]): gli ALTRI presenti
// (mai chi guarda: la sua presenza conta per il segnale della sezione, non
// qui), 24 px, iniziali 11 px 600, anello di 2 px nel colore della persona,
// sovrapposti di 4 px; al più quattro e «+N». Il nome sempre nel `title` e
// nel nome accessibile: «Marco Bellini · writing in Rules», «Matteo Conti ·
// reading». Le persone arrivano da `getProductPresence` (filtrate per chi
// guarda, R-G5), mai dal segnale di sezione del livello dati, che non lo è. Entrano ed escono in
// dissolvenza di 150 ms (niente col movimento ridotto); un arrivo si dice
// una volta («Marco Bellini joined»).

const MAX = 4;

/** Il titolo della sezione in cui scrive (testo della pagina: chi guarda lo legge già). */
function sectionTitle(blocks: readonly ProductBlock[], anchorId: string): string | null {
  const id = sectionOf(blocks, anchorId);
  const heading = id ? blocks.find((b) => b.id === id) : undefined;
  const text = heading && isTextBlock(heading) ? heading.content.text.trim() : "";
  return text === "" ? null : text;
}

export function PresenceAvatars({ page }: { page: ProductPageView }) {
  const { t } = useTranslation();
  const presence = useProductPresence(page.id);
  const people = presence.data ?? [];

  const labelOf = (p: ProductPresenceView) => {
    if (p.anchorId === null) return t("productDocs.live.reading", { name: p.name });
    const section = sectionTitle(page.blocks, p.anchorId);
    return section
      ? t("productDocs.live.writingIn", { name: p.name, section })
      : t("productDocs.live.writing", { name: p.name });
  };

  // Chi se ne va resta 150 ms, in dissolvenza e fuori dall'albero accessibile.
  const [leaving, setLeaving] = useState<ProductPresenceView[]>([]);
  const before = useRef<ProductPresenceView[] | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Un arrivo si annuncia una volta; chi c'era già all'apertura no.
  const [announce, setAnnounce] = useState("");
  const ids = people.map((p) => p.personId).join(",");
  useEffect(() => {
    if (!presence.data) return;
    const prev = before.current;
    before.current = presence.data;
    if (prev === null) return;
    const gone = prev.filter((p) => !presence.data.some((q) => q.personId === p.personId));
    const came = presence.data.filter((p) => !prev.some((q) => q.personId === p.personId));
    if (came.length > 0)
      setAnnounce(came.map((p) => t("productDocs.live.joined", { name: p.name })).join(". "));
    if (gone.length > 0) {
      setLeaving((l) => [
        ...l.filter((x) => !gone.some((g) => g.personId === x.personId)),
        ...gone,
      ]);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setLeaving((l) => l.filter((x) => !gone.includes(x)));
      }, 150);
      timers.current.add(timer);
    }
    // conta solo chi c'è
  }, [ids]);
  useEffect(() => {
    const all = timers.current;
    return () => all.forEach(clearTimeout);
  }, []);

  const shown = people.slice(0, MAX);
  const rest = people.slice(MAX);
  const fading = leaving.filter((p) => !people.some((q) => q.personId === p.personId));
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
      {(people.length > 0 || fading.length > 0) && (
        <span
          role="group"
          aria-label={t("productDocs.live.people")}
          className="mx-1 flex shrink-0 items-center"
        >
          {shown.map((p, i) => (
            <Avatar key={p.personId} person={p} label={labelOf(p)} first={i === 0} />
          ))}
          {rest.length > 0 && (
            <span
              role="img"
              aria-label={t("productDocs.live.more", {
                count: rest.length,
                names: rest.map(labelOf).join(", "),
              })}
              title={rest.map(labelOf).join("\n")}
              className="num relative -ml-1 grid size-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--ink)_10%,var(--ground))] text-[11px] font-semibold text-ink-muted ring-2 ring-ground"
            >
              +{rest.length}
            </span>
          )}
          {fading.map((p) => (
            <Avatar key={`gone-${p.personId}`} person={p} label={null} first={false} />
          ))}
        </span>
      )}
    </>
  );
}

function Avatar({
  person,
  label,
  first,
}: {
  person: ProductPresenceView;
  label: string | null;
  first: boolean;
}) {
  const gone = label === null;
  return (
    <span
      role={gone ? undefined : "img"}
      aria-label={label ?? undefined}
      aria-hidden={gone ? "true" : undefined}
      title={label ?? undefined}
      data-presence-avatar={person.personId}
      className={`relative grid size-6 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--ink)_10%,var(--ground))] text-[11px] font-semibold text-ink ${first ? "" : "-ml-1"} ${gone ? "presence-leave" : "event-enter"}`}
      // L'anello di 2 px nel colore della persona, e 1 px di fondo che separa i sovrapposti.
      style={{
        boxShadow: `0 0 0 1px var(--ground), inset 0 0 0 2px ${presenceColor(person.color)}`,
      }}
    >
      {person.initials}
    </span>
  );
}
