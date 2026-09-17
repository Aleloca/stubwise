import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GlobalSearchSheet } from "./GlobalSearchSheet";
import { SettingsAvatarButton } from "./SettingsAvatarButton";
import { colors } from "../theme/tokens";
import { fontFamily, textStyles } from "../theme/typography";

/**
 * Intestazione di schermata (Task 7, App M1+M2, 11 set 2026): titolo +
 * sottotitolo opzionale + l'avatar (unico accesso alle Impostazioni). Va
 * come PRIMO figlio dentro lo `ScrollView` di ogni schermata — mai fratello,
 * o torna il problema che questo task risolve (l'header fermo, il contenuto
 * che scorre sotto la tab bar nativa senza un margine) — E il chiamante deve
 * passare `stickyHeaderIndices={[0]}` allo `ScrollView` (fix di review
 * dell'11 set 2026, Task 2, vedi sotto).
 *
 * L'avatar prima viveva ANCORATO in `AppProviders` (Task 20), fuori dal
 * contenuto scorrevole. Decisione del maintainer: scorre col contenuto,
 * come i titoli grandi di iOS — il banner offline (stato del sistema, non
 * pezzo di pagina) resta ancorato lì, l'avatar no.
 *
 * **Fix di review (11 set 2026,
 * `docs/plans/2026-09-11-app-m1-m2-review-fixes-plan.md`, Task 2)**: il Task
 * 7 aveva lasciato l'avatar scorrere via SENZA restare ancorato da nessuna
 * parte — il design parlava di un header che scorre "e si contrae, come i
 * titoli grandi di iOS": la contrazione era il punto, perché lì la barra
 * compatta resta ancorata. Qui si ottiene lo STESSO risultato (le
 * Impostazioni raggiungibili da qualunque posizione di scorrimento) con un
 * meccanismo più semplice della vera animazione di contrazione:
 * `stickyHeaderIndices={[0]}` di `ScrollView` — nativo di React Native, non
 * codice scritto a mano — fissa questo header in cima per tutta la durata
 * dello scroll, invece di farlo scorrere via. `backgroundColor` qui sotto è
 * necessario per questo: senza, il contenuto sotto lo attraverserebbe
 * visivamente scorrendo.
 */
/**
 * `onBack`/`backLabel` (13 set 2026): una schermata di DETTAGLIO — che ha un
 * indietro — può usare questo stesso header invece di costruirsene uno suo.
 * Prima le schermate di dettaglio ne avevano uno a mano con solo «indietro»
 * e l'avatar, e il titolo restava nel corpo che scorre: nel dettaglio di una
 * email questo voleva dire perdere di vista l'OGGETTO appena si scendeva di
 * due dita, cioè il pezzo che dice di cosa si sta leggendo.
 *
 * `titleNumberOfLines` esiste per lo stesso motivo: un oggetto di email non
 * è un titolo di schermata scritto da noi, può essere lungo quanto vuole chi
 * l'ha mandato — si tronca, non si lascia crescere l'header finché copre
 * mezzo schermo.
 */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel,
  titleNumberOfLines,
  showAvatar = true,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backLabel?: string;
  titleNumberOfLines?: number;
  /**
   * `false` SOLO sulla pagina Impostazioni (16 set 2026): lì l'avatar è il
   * bottone che ci ha portati, e porterebbe a se stessa. Ovunque altro
   * l'avatar c'è sempre — è l'unico accesso alle Impostazioni, e nasconderlo
   * altrove renderebbe irraggiungibile una pagina.
   */
  showAvatar?: boolean;
}) {
  const { t } = useTranslation();
  // ⚠️ La ricerca è un'AZIONE e vive QUI, non nella tab bar: le cinque
  // destinazioni sono decise per tutte le fasi e la ricerca non ne aggiunge
  // una sesta (design 15 set 2026 §3). Stando nell'intestazione è
  // raggiungibile da ogni schermata che la usa — che sono tutte e cinque le
  // radici di scheda, più i dettagli.
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <View style={styles.row}>
      <View style={styles.titleBlock}>
        {onBack !== undefined && (
          <Pressable accessibilityRole="button" onPress={onBack} testID="screen-header-back">
            <Text style={styles.back}>{backLabel}</Text>
          </Pressable>
        )}
        <Text
          style={textStyles.screenTitle}
          {...(titleNumberOfLines !== undefined ? { numberOfLines: titleNumberOfLines } : {})}
        >
          {title}
        </Text>
        {subtitle !== undefined && <Text style={textStyles.screenSubtitle}>{subtitle}</Text>}
      </View>
      <View style={styles.actions}>
        {/*
          ⚠️ La ricerca NON è gated su `showAvatar`, e la differenza è
          voluta: l'avatar sparisce sulle Impostazioni perché lì porterebbe a
          se stesso, mentre cercare da dentro le Impostazioni è una cosa
          sensata. Sono due bottoni con due ragioni diverse di esserci.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.search.openLabel")}
          onPress={() => setSearchOpen(true)}
          style={styles.searchButton}
          testID="global-search-trigger"
        >
          <SearchGlyph />
        </Pressable>
        {showAvatar && <SettingsAvatarButton />}
      </View>
      {/*
        Montato SOLO quando è aperto, e non è un dettaglio di performance: il
        foglio usa `useNavigation`, e questo header sta su ogni schermata —
        tenerlo montato significherebbe un `Modal` e un hook di navigazione
        per ogni schermata dell'app, sempre, per una cosa che si apre di
        rado. Come effetto, un test che monta solo l'intestazione non ha
        bisogno di un `NavigationContainer`.
      */}
      {searchOpen && <GlobalSearchSheet visible onRequestClose={() => setSearchOpen(false)} />}
    </View>
  );
}

/** La lente: l'anello più il manico in diagonale. Vedi gli stili in fondo. */
function SearchGlyph() {
  return (
    <>
      <View style={styles.glyphRing} />
      <View style={styles.glyphHandle} />
    </>
  );
}

const styles = StyleSheet.create({
  // `paddingHorizontal: 20`/`paddingTop: 56` erano ripetuti IDENTICI in ogni
  // schermata tab-root prima di questo task (Inbox/Projects/Backlog/Docs):
  // qui vivono in UN posto solo. `paddingTop: 56` è lo stesso margine fisso
  // già in uso in tutto l'app per lo spazio della status bar (nessuno
  // screen di questo repo usa `useSafeAreaInsets` — non è la convenzione
  // esistente, e non è questo il task per cambiarla). `backgroundColor`
  // (fix di review, Task 2): necessario perché l'header è ora ANCORATO
  // (`stickyHeaderIndices`) — senza, il contenuto sotto lo attraverserebbe.
  row: {
    alignItems: "flex-start",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  titleBlock: {
    flex: 1,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  /**
   * Gemello dell'avatar (`SettingsAvatarButton`): stesse 32×32, stesso
   * `borderRadius: 16`, stesso fondo. Prima era un rettangolo con scritto
   * «CERCA» e stonava accanto a un cerchio — richiesta del maintainer del
   * 16 set 2026. I due bottoni fanno la stessa cosa (aprono qualcosa) e ora
   * si somigliano.
   */
  searchButton: {
    alignItems: "center",
    backgroundColor: colors.ink800,
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  /**
   * La lente, disegnata con due `View` invece che con un'icona.
   *
   * L'app non ha né una libreria di icone né `react-native-svg`, e
   * aggiungerne una per UN glifo significherebbe una dipendenza **nativa**:
   * `pod install`, e una verifica su device che la CI non copre (vedi
   * `apps/mobile/README.md`). Due `View` costano niente, si rendono identiche
   * su ogni telefono e non dipendono da quali glifi ha il font di sistema —
   * cosa che un carattere Unicode come `⌕` non garantisce affatto.
   */
  glyphRing: {
    borderColor: colors.muted,
    borderRadius: 6,
    borderWidth: 1.5,
    height: 12,
    width: 12,
  },
  glyphHandle: {
    backgroundColor: colors.muted,
    borderRadius: 1,
    bottom: 3,
    height: 5.5,
    position: "absolute",
    right: 7,
    transform: [{ rotate: "-45deg" }],
    width: 1.5,
  },
  back: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 0.6,
    marginBottom: 6,
    textTransform: "uppercase",
  },
});
