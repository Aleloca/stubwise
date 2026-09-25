import type { ImageSourcePropType } from "react-native";
import wiseyTabSharp from "../../assets/wisey/wisey-tab-sharp.png";
import wiseyTabSmooth from "../../assets/wisey/wisey-tab-smooth.png";

/**
 * L'ICONA DELLA TAB WISEY (25 set 2026): il PRIMO fotogramma di riposo del
 * gufo Classic della 5a, 56×48, mostrato a 28×24 pt. Non il gufo Minimal:
 * il maintainer l'ha scartato dopo averlo visto nella barra sul telefono.
 *
 * Le due varianti sono identiche a 1× e a @2x (il fotogramma 1:1) e
 * differiscono SOLO a @3x, dove il fattore è 1,5 e nessuna scala è perfetta
 * — il ragionamento completo è nel docblock di `scripts/wisey-assets.py`:
 *
 *   - `wiseyTabSharp`  (a): NEAREST a 1,5×, pixel netti ma irregolari;
 *   - `wiseyTabSmooth` (b): NEAREST a 3× e poi LANCZOS, fedele ma morbida.
 *
 * ⚠️ Questa riga è l'UNICO posto in cui si sceglie: passare all'altra è
 * cambiare il nome qui sotto.
 */
export const WISEY_TAB_ICON: ImageSourcePropType = wiseyTabSharp;

/** L'alternativa, tenuta importata perché il cambio sia davvero una riga. */
export const WISEY_TAB_ICON_ALTERNATIVE: ImageSourcePropType = wiseyTabSmooth;
