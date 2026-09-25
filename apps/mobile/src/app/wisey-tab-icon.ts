import type { ImageSourcePropType } from "react-native";
import wiseyTabEmpty from "../../assets/wisey/wisey-tab-empty.png";

/**
 * L'ICONA DELLA TAB NATIVA DI WISEY: TRASPARENTE (25 set 2026, design §11).
 *
 * Wisey nella barra è il cerchio nostro che sporge sopra
 * (`components/wisey/WiseyTabButton.tsx`), col gufo animato. La tab nativa
 * sotto resta, così le altre quattro tengono il loro posto, ma non deve
 * disegnare niente: la copre il cerchio.
 *
 * Prima (§10) questa era l'icona animata del gufo, cambiata a ogni
 * fotogramma dentro la barra nativa: quel meccanismo è stato tolto, e con lui
 * i suoi 72 file e il suo passo minimo.
 */
export const WISEY_TAB_ICON: ImageSourcePropType = wiseyTabEmpty;
