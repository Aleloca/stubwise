import { TrueSheet } from "@lodev09/react-native-true-sheet";
import type { SheetDetent } from "@lodev09/react-native-true-sheet";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { colors } from "../theme/tokens";

/**
 * IL PANNELLO DELL'APP — tutte le finestre che salgono dal fondo, le due
 * pagine a tutta altezza e la conferma di cancellazione (24 set 2026, design
 * «pannelli nativi»).
 *
 * Il contenitore non è nostro e non è di una libreria che lo ridisegna: è
 * quello di sistema — `UISheetPresentationController` su iOS, via
 * `@lodev09/react-native-true-sheet`. Il trascinamento per chiudere, la lista
 * che cede il gesto quando è in cima, il velo, l'elastico: tutto arriva da
 * lì. Prima erano `Modal` con un velo disegnato a mano (`rgba(5,7,10,0.7)`) e
 * un pannello ancorato in basso — niente trascinamento, e un velo opaco che
 * non era quello di iOS: la segnalazione del maintainer.
 *
 * Ci siamo arrivati per esclusione in Half Story, stessa React Native (0.87.1)
 * e stessa New Architecture (`half-story-app/src/components/ui/SheetModal.tsx`,
 * da cui questo discende). Un `PanResponder` scritto a mano sa RUBARE il gesto
 * a chi l'ha già preso, ma dove nessuno lo prende — la maniglia — non c'è
 * niente da rubare e il pannello non si muove. `@gorhom/bottom-sheet` è
 * scritto per Reanimated 3: con la 4 i pannelli non si aprono e non dicono
 * perché. Il foglio di sistema non ha nessuno dei due problemi, perché non è
 * JavaScript — e non chiede Reanimated (per true-sheet è facoltativo).
 *
 * LE TRE LEZIONI DI HALF STORY, che valgono anche qui:
 *
 * 1. **L'altezza si dice, non si indovina.** Il detent `auto` si misura da sé
 *    sul contenuto ma NON convive con una lista che scorre: messi insieme il
 *    pannello si pianta a tutta altezza anche con tre righe. Chi non scorre
 *    usa `auto` (`scrollable={false}`); chi scorre passa `contentHeight` —
 *    oppure, se non la conosce, il pannello misura il contenuto da sé e ne fa
 *    la frazione di schermo a cui fermarsi.
 * 2. **Il safe area in fondo lo mette il sistema** (`insetAdjustment:
 *    'automatic'`, il default): aggiungerne un secondo qui lascerebbe un dito
 *    di vuoto sotto l'ultimo bottone.
 * 3. **`keyboardShouldPersistTaps="handled"`** sulla lista: con un campo di
 *    testo dentro, senza, il primo tocco su un bottone chiude solo la
 *    tastiera e ne serve un secondo.
 *
 * LA TASTIERA la gestisce true-sheet (`TrueSheetKeyboardObserver`: il
 * pannello cresce e lo scroll riceve l'inset). Per questo i pannelli con un
 * campo di testo non usano più `SheetBackdrop`, che la gestiva con un
 * `KeyboardAvoidingView` insieme al velo: dentro il foglio nativo il velo
 * sarebbe tornato opaco, e lo spostamento si sarebbe applicato due volte.
 */

/** Il respiro sopra il contenuto: la maniglia di sistema galleggia sopra, non spinge. */
const CONTENT_TOP = 28;
/** Lo stacco in fondo — NON il safe area, che aggiunge il sistema (lezione 2). */
const CONTENT_BOTTOM = 12;
const CORNER_RADIUS = 16;

export interface SheetModalProps {
  /** Aperto o chiuso: il pannello segue questo, non il contrario. */
  open: boolean;
  /**
   * Il pannello si è chiuso, da qualunque strada: trascinamento, tocco sul
   * velo, tasto indietro di Android. È l'UNICA strada: nessun pannello ha più
   * un suo velo o un suo «tocco fuori».
   */
  onClose: () => void;
  children: ReactNode;
  /**
   * Il contenuto scorre (default sì). Una scheda corta a lunghezza fissa —
   * i tempi di un «rimanda», una conferma — no: allora il pannello si misura
   * da sé col detent `auto` (lezione 1).
   */
  scrollable?: boolean;
  /**
   * Quanto è alto IL SOLO CONTENUTO, in punti, per chi scorre. Assente, il
   * pannello lo misura dopo il primo layout.
   */
  contentHeight?: number;
  /** La frazione di schermo oltre la quale non cresce. Default 0.9. */
  maxFraction?: number;
  /**
   * Una PAGINA, non un pannello: a tutta altezza, e il contenuto porta il suo
   * scroll (la ricerca, «leggi il piano»). Nessuna misura.
   */
  fullHeight?: boolean;
  /**
   * Si può mandare via — trascinandolo, toccando il velo, col tasto
   * indietro. Default sì. Lo spegne chi ha un'operazione in corso che non si
   * interrompe a metà: la cancellazione, mentre il server sta cancellando —
   * altrimenti l'esito arriverebbe su una finestra che non c'è più. Senza,
   * sparisce anche la maniglia: il pannello dice da sé che non si chiude.
   */
  dismissible?: boolean;
  testID?: string;
}

export function SheetModal({
  open,
  onClose,
  children,
  scrollable = true,
  contentHeight,
  maxFraction = 0.9,
  fullHeight = false,
  dismissible = true,
  testID,
}: SheetModalProps) {
  const sheet = useRef<TrueSheet>(null);
  const { height: screen } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);

  const height = contentHeight ?? measured;
  const fraction =
    height === null
      ? maxFraction
      : Math.min(maxFraction, (height + CONTENT_TOP + CONTENT_BOTTOM) / screen);

  useEffect(() => {
    if (open) {
      sheet.current?.present().catch(() => {});
    } else {
      sheet.current?.dismiss().catch(() => {});
    }
  }, [open]);

  // Il tipo della LIBRERIA, non un cast: è la prop più delicata del foglio, e
  // `SheetDetent` accetta esattamente le due forme che usiamo — una frazione
  // di schermo (0–1) o `'auto'`.
  const detents: SheetDetent[] = fullHeight ? [1] : scrollable ? [fraction] : ["auto"];

  return (
    <TrueSheet
      ref={sheet}
      detents={detents}
      backgroundColor={colors.ink900}
      cornerRadius={CORNER_RADIUS}
      grabber={dismissible}
      dimmed
      dismissible={dismissible}
      draggable={dismissible}
      scrollable={scrollable || fullHeight}
      onDidDismiss={onClose}
    >
      {fullHeight ? (
        <View testID={testID} style={styles.page}>
          {children}
        </View>
      ) : scrollable ? (
        <ScrollView
          testID={testID}
          // Lezione 3: col campo di testo, il primo tocco su un bottone deve
          // premerlo, non solo chiudere la tastiera.
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <View
            onLayout={(event) => {
              if (contentHeight !== undefined) return;
              const next = event.nativeEvent.layout.height;
              // Un punto di tolleranza: rimisurare per un arrotondamento
              // farebbe ribattere il detent all'infinito.
              setMeasured((current) =>
                current !== null && Math.abs(current - next) <= 1 ? current : next,
              );
            }}
          >
            {children}
          </View>
        </ScrollView>
      ) : (
        <View testID={testID} style={styles.content}>
          {children}
        </View>
      )}
    </TrueSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: CONTENT_BOTTOM,
    paddingHorizontal: 20,
    paddingTop: CONTENT_TOP,
  },
  page: {
    flex: 1,
    paddingTop: CONTENT_TOP,
  },
});
