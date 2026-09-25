import { useEffect, useState } from "react";
import type { ImageSourcePropType } from "react-native";
import tabRiposo0 from "../../assets/wisey/wisey-tab-riposo-0.png";
import tabRiposo1 from "../../assets/wisey/wisey-tab-riposo-1.png";
import tabRiposo2 from "../../assets/wisey/wisey-tab-riposo-2.png";
import tabRiposo3 from "../../assets/wisey/wisey-tab-riposo-3.png";
import tabAscolta0 from "../../assets/wisey/wisey-tab-ascolta-0.png";
import tabAscolta1 from "../../assets/wisey/wisey-tab-ascolta-1.png";
import tabAscolta2 from "../../assets/wisey/wisey-tab-ascolta-2.png";
import tabAscolta3 from "../../assets/wisey/wisey-tab-ascolta-3.png";
import tabPensa0 from "../../assets/wisey/wisey-tab-pensa-0.png";
import tabPensa1 from "../../assets/wisey/wisey-tab-pensa-1.png";
import tabPensa2 from "../../assets/wisey/wisey-tab-pensa-2.png";
import tabPensa3 from "../../assets/wisey/wisey-tab-pensa-3.png";
import tabLavora0 from "../../assets/wisey/wisey-tab-lavora-0.png";
import tabLavora1 from "../../assets/wisey/wisey-tab-lavora-1.png";
import tabLavora2 from "../../assets/wisey/wisey-tab-lavora-2.png";
import tabLavora3 from "../../assets/wisey/wisey-tab-lavora-3.png";
import tabParla0 from "../../assets/wisey/wisey-tab-parla-0.png";
import tabParla1 from "../../assets/wisey/wisey-tab-parla-1.png";
import tabParla2 from "../../assets/wisey/wisey-tab-parla-2.png";
import tabParla3 from "../../assets/wisey/wisey-tab-parla-3.png";
import tabFatto0 from "../../assets/wisey/wisey-tab-fatto-0.png";
import tabFatto1 from "../../assets/wisey/wisey-tab-fatto-1.png";
import tabFatto2 from "../../assets/wisey/wisey-tab-fatto-2.png";
import tabFatto3 from "../../assets/wisey/wisey-tab-fatto-3.png";
import { useReduceMotion } from "../lib/use-reduce-motion";
import { WISEY_CYCLE_MS, type WiseyPhase } from "../lib/wisey-phase";

/**
 * L'ICONA DELLA TAB WISEY (25 set 2026): il gufo Classic della 5a a 28×24 pt,
 * con 3 pt di margine trasparente sotto, variante morbida a @3x — come e
 * perché lo spiega il docblock di `scripts/wisey-assets.py`, che la genera.
 *
 * SI ANIMA sulla stessa fase del gufo grande (design §10, decisione del
 * maintainer che supera «nella tab bar resta fermo»). La barra nativa non
 * anima immagini: per questo ogni fotogramma di ogni fase è un'icona a sé, e
 * {@link useWiseyTabIcon} restituisce quella del momento — la barra la riceve
 * a ogni cambio.
 */
export const WISEY_TAB_FRAMES: Record<WiseyPhase, readonly ImageSourcePropType[]> = {
  rest: [tabRiposo0, tabRiposo1, tabRiposo2, tabRiposo3],
  listen: [tabAscolta0, tabAscolta1, tabAscolta2, tabAscolta3],
  think: [tabPensa0, tabPensa1, tabPensa2, tabPensa3],
  work: [tabLavora0, tabLavora1, tabLavora2, tabLavora3],
  speak: [tabParla0, tabParla1, tabParla2, tabParla3],
  done: [tabFatto0, tabFatto1, tabFatto2, tabFatto3],
};

/**
 * Il passo minimo fra due fotogrammi dell'icona della barra, in ms. Oggi 120,
 * cioè NESSUN limite: «ti risponde» ha già un passo di 120 ms, e si prova
 * prima al vero ritmo. ⚠️ Ogni cambio passa dalla barra NATIVA: se sul
 * telefono sfarfalla o scatta, si alza qui (per esempio a 250) — il gufo
 * grande resta alla velocità del design.
 */
export const WISEY_TAB_MIN_FRAME_MS = 120;

/**
 * L'icona della tab per la fase data, che avanza sul ciclo della fase (un
 * passo ogni quarto di ciclo, mai più spesso di {@link WISEY_TAB_MIN_FRAME_MS}).
 * Con la riduzione del movimento di sistema resta sul primo fotogramma della
 * fase: la fase si vede lo stesso, il movimento no.
 */
export function useWiseyTabIcon(phase: WiseyPhase): ImageSourcePropType {
  const reduceMotion = useReduceMotion();
  // Il fotogramma è legato alla SUA fase: al cambio di fase si mostra subito
  // il primo della nuova, senza un render col fotogramma rimasto dalla
  // vecchia (l'azzeramento nell'effetto arriverebbe un render dopo, e ogni
  // render qui è un'icona nuova spedita alla barra nativa).
  const [tick, setTick] = useState<{ phase: WiseyPhase; frame: number }>({ phase, frame: 0 });
  const frames = WISEY_TAB_FRAMES[phase];

  useEffect(() => {
    setTick({ phase, frame: 0 });
    if (reduceMotion) return undefined;
    const step = Math.max(WISEY_CYCLE_MS[phase] / frames.length, WISEY_TAB_MIN_FRAME_MS);
    const timer = setInterval(
      () => setTick((current) => ({ phase, frame: (current.frame + 1) % frames.length })),
      step,
    );
    return () => clearInterval(timer);
  }, [frames.length, phase, reduceMotion]);

  const frame = !reduceMotion && tick.phase === phase ? tick.frame : 0;
  return frames[frame % frames.length]!;
}
