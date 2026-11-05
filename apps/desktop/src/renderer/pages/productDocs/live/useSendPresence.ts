import { useEffect, useRef } from "react";
import { useSetProductPresence } from "../../../data/queries";

// Dove scrive chi guarda, per gli altri (shape product-editor.md §3.13): il
// blocco col fuoco, il cursore e la selezione; `null` fuori dai blocchi (c'è
// ma non scrive). Al più una scrittura ogni 150 ms: la prima subito, poi
// l'ultima posizione alla fine dell'attesa (le intermedie si saltano), e una
// posizione uguale all'ultima mandata non si rimanda. Solo l'editor di chi
// scrive la usa: un'ancora chiede `docs.edit` (Task 5), chi legge c'è con
// l'ancora `null` dal suo ingresso.

const EVERY_MS = 150;

export interface PresenceAt {
  anchorId: string;
  offset: number;
  selection: [number, number] | null;
}

export function useSendPresence(pageId: string, at: PresenceAt | null) {
  const set = useSetProductPresence();
  const mutate = useRef(set.mutate);
  mutate.current = set.mutate;
  const latest = useRef<PresenceAt | null>(at);
  latest.current = at;
  // L'ingresso ha già messo la presenza senza ancora.
  const sent = useRef(JSON.stringify(null));
  const cooling = useRef<ReturnType<typeof setTimeout> | null>(null);

  const key = JSON.stringify(at);
  useEffect(() => {
    const send = () => {
      const now = JSON.stringify(latest.current);
      if (now === sent.current) return false;
      sent.current = now;
      // Un rifiuto (lo scarto non c'è più nella frase salvata) non dice niente: la prossima posizione rimedia.
      mutate.current({ pageId, at: latest.current });
      return true;
    };
    const cool = () => {
      cooling.current = setTimeout(() => {
        cooling.current = null;
        if (send()) cool();
      }, EVERY_MS);
    };
    if (cooling.current) return;
    if (send()) cool();
  }, [key, pageId]);

  useEffect(
    () => () => {
      if (cooling.current) clearTimeout(cooling.current);
    },
    [],
  );
}
