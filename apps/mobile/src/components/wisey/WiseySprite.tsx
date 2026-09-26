import { useEffect, useState } from "react";
import { Image, type ImageSourcePropType, StyleSheet, View } from "react-native";
import gufoAscoltaButton from "../../../assets/wisey/gufo-ascolta-button.png";
import gufoFattoButton from "../../../assets/wisey/gufo-fatto-button.png";
import gufoLavoraButton from "../../../assets/wisey/gufo-lavora-button.png";
import gufoParlaButton from "../../../assets/wisey/gufo-parla-button.png";
import gufoPensaButton from "../../../assets/wisey/gufo-pensa-button.png";
import gufoRiposoButton from "../../../assets/wisey/gufo-riposo-button.png";
import gufoAscolta from "../../../assets/wisey/gufo-ascolta.png";
import gufoAscoltaLarge from "../../../assets/wisey/gufo-ascolta-large.png";
import gufoFatto from "../../../assets/wisey/gufo-fatto.png";
import gufoFattoLarge from "../../../assets/wisey/gufo-fatto-large.png";
import gufoLavora from "../../../assets/wisey/gufo-lavora.png";
import gufoLavoraLarge from "../../../assets/wisey/gufo-lavora-large.png";
import gufoParla from "../../../assets/wisey/gufo-parla.png";
import gufoParlaLarge from "../../../assets/wisey/gufo-parla-large.png";
import gufoPensa from "../../../assets/wisey/gufo-pensa.png";
import gufoPensaLarge from "../../../assets/wisey/gufo-pensa-large.png";
import gufoRiposo from "../../../assets/wisey/gufo-riposo.png";
import gufoRiposoLarge from "../../../assets/wisey/gufo-riposo-large.png";
import { useReduceMotion } from "../../lib/use-reduce-motion";
import { useScreenFocused } from "../../lib/use-screen-focused";
import { WISEY_CYCLE_MS, type WiseyPhase } from "../../lib/wisey-phase";

const FRAMES = 4;

/**
 * Un fotogramma, in punti: il disegno è 56×48, il gufo grande lo mostra a 2×,
 * quello del cerchio sopra la barra a 0,75× (design §11).
 */
const FRAME_SIZE = {
  small: { width: 56, height: 48 },
  large: { width: 112, height: 96 },
  button: { width: 42, height: 36 },
} as const;

type SpriteSize = keyof typeof FRAME_SIZE;

/**
 * Le fasi hanno nomi inglesi nel codice, gli sprite dell'export di design
 * nomi italiani: la corrispondenza sta QUI, in un posto solo. Il gufo grande
 * ha i suoi file pre-scalati (`scripts/wisey-assets.py`), perché iOS scalando
 * da sé sfocherebbe la pixel art.
 */
const SPRITES: Record<WiseyPhase, Record<SpriteSize, ImageSourcePropType>> = {
  rest: { small: gufoRiposo, large: gufoRiposoLarge, button: gufoRiposoButton },
  listen: { small: gufoAscolta, large: gufoAscoltaLarge, button: gufoAscoltaButton },
  think: { small: gufoPensa, large: gufoPensaLarge, button: gufoPensaButton },
  work: { small: gufoLavora, large: gufoLavoraLarge, button: gufoLavoraButton },
  speak: { small: gufoParla, large: gufoParlaLarge, button: gufoParlaButton },
  done: { small: gufoFatto, large: gufoFattoLarge, button: gufoFattoButton },
};

/**
 * IL GUFO («Wisey, anteprima nell'app», 25 set 2026, design §7): quattro
 * fotogrammi affiancati in un PNG, un timer a quattro passi che sposta
 * l'immagine dentro un contenitore che la ritaglia. Nessuna libreria di
 * animazione e nessuna interpolazione fra fotogrammi: è pixel art, e ogni
 * passo è un fotogramma intero.
 *
 * Resta FERMO al primo fotogramma in tre casi:
 * - `animated={false}`: il gufo piccolo accanto ai messaggi — regola del
 *   design, una sola istanza animata per schermata;
 * - la riduzione del movimento di sistema è attiva: lo stato lo dice la riga
 *   di testo sotto il gufo, non il movimento;
 * - la schermata non è a fuoco: le schede restano montate, e un timer che
 *   gira su una tab che nessuno guarda è lavoro buttato.
 *
 * È decorativo per l'accessibilità: quello che il gufo dice a colpo
 * d'occhio lo dice anche il testo accanto.
 */
export function WiseySprite({
  phase,
  size,
  animated = true,
}: {
  phase: WiseyPhase;
  size: SpriteSize;
  animated?: boolean;
}) {
  const focused = useScreenFocused();
  const reduceMotion = useReduceMotion();
  const running = animated && focused && !reduceMotion;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    if (!running) return undefined;
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES), WISEY_CYCLE_MS[phase] / FRAMES);
    return () => clearInterval(timer);
  }, [phase, running]);

  const { width, height } = FRAME_SIZE[size];
  const shown = running ? frame : 0;

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.clip, { width, height }]}
      testID="wisey-sprite"
    >
      <Image
        source={SPRITES[phase][size]}
        style={{ width: width * FRAMES, height, marginLeft: -shown * width }}
        testID="wisey-sprite-image"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: "hidden",
  },
});
