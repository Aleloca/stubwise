import type { ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet } from "react-native";

/**
 * ⚠️ **NON USATO dal 24 set 2026**, in attesa della prova sul telefono della
 * gestione nativa della tastiera — vedi il design §4
 * (`docs/plans/2026-09-24-native-sheets-design.md`). I quattro pannelli che lo
 * usavano (`CaptureSheet`, `RejectSheet`, `QuestionSheet`, `LabelsSheet`) sono
 * diventati il foglio nativo (`SheetModal`), che la tastiera la gestisce da sé:
 * lasciato attorno a loro avrebbe ridisegnato il velo opaco dentro il foglio e
 * spostato il contenuto due volte. Resta qui, coi suoi test, finché il
 * telefono non conferma che la tastiera non copre i campi; se li coprisse, si
 * rimette il solo `KeyboardAvoidingView` dentro il pannello.
 *
 * Lo sfondo di una finestra ANCORATA IN BASSO che contiene un campo di testo
 * (24 set 2026): il velo scuro, il tocco fuori che chiude, e — la ragione per
 * cui esiste — lo spostamento sopra la tastiera.
 *
 * ⚠️ **Senza `KeyboardAvoidingView`, su iOS la tastiera copre il campo
 * esattamente mentre si scrive.** La finestra sta in fondo allo schermo, e la
 * tastiera sale dal fondo. Il difetto c'era in TRE finestre insieme — il
 * rifiuto di un piano (`RejectSheet`), la voce nuova di backlog
 * (`CaptureSheet`), la risposta libera a una domanda dell'agente
 * (`QuestionSheet`) — e l'aveva corretto solo la quarta, quella delle
 * etichette (`LabelsSheet`), scritta per ultima: la correzione scritta in
 * un posto non raggiunge gli altri.
 *
 * Per questo è un componente e non una riga da ricordare: **chi scrive una
 * finestra nuova ancorata in basso con un campo di testo usi questo**, e la
 * tastiera è già risolta. Le finestre senza campo di testo (`ChoiceSheet`,
 * `SnoozeSheet`) non ne hanno bisogno e restano come sono.
 *
 * Su Android `behavior` resta indefinito: lì la finestra si ridimensiona da
 * sola (`windowSoftInputMode`), e `padding` la spingerebbe su due volte.
 */
/**
 * Il `behavior` di `KeyboardAvoidingView` per una finestra ancorata in basso.
 * Una funzione a sé per poterla fissare in un test: Testing Library v14 non
 * espone più le prop di un componente (`UNSAFE_getByType` è stato tolto),
 * e sulla `View` nativa che `KeyboardAvoidingView` disegna `behavior` non c'è.
 */
export function sheetKeyboardBehavior(os: string): "padding" | undefined {
  return os === "ios" ? "padding" : undefined;
}

export function SheetBackdrop({
  onDismiss,
  dismissLabel,
  children,
}: {
  /** Tocco sul velo, fuori dalla finestra. */
  onDismiss: () => void;
  /** Etichetta di accessibilità del velo («Annulla», «Chiudi»…). */
  dismissLabel: string;
  children: ReactNode;
}) {
  return (
    <KeyboardAvoidingView
      behavior={sheetKeyboardBehavior(Platform.OS)}
      style={styles.backdrop}
      testID="sheet-backdrop"
    >
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss} accessibilityLabel={dismissLabel} />
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(5,7,10,0.7)",
    flex: 1,
    justifyContent: "flex-end",
  },
});
