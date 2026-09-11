import { colors } from "./tokens";

/**
 * Font del design: IBM Plex Sans (corpo, titoli) e IBM Plex Mono (etichette
 * maiuscole, wordmark, badge, cifre) — vedi il canvas.
 *
 * Entrambe le famiglie sono build STATICHE vere, non fabbricate — scaricate
 * dal servizio di download ufficiale di Google Fonts
 * (`fonts.google.com/download?family=…`, OFL-1.1, licenza in
 * `assets/fonts/OFL.txt`), che genera un'istanza statica per peso a partire
 * dal font variabile sorgente. PostScript name verificato con `fontTools`
 * prima di committare: `IBMPlexSans-Regular`, `-Medium`, `-SemiBold`,
 * `-Bold` (e i quattro pesi gemelli di Mono), tutti distinti — è la stringa
 * che va in `fontFamily`. Cablati in iOS e Android con `npx
 * react-native-asset` (vedi `react-native.config.js`).
 *
 * App M1 (11 set 2026): fino a questo task il Sans NON c'era — solo i
 * quattro pesi Mono, e il corpo del testo usava il sans di SISTEMA. Il
 * motivo, verificato allora: il repo sorgente di Google Fonts
 * (`github.com/google/fonts`) per IBM Plex Sans pubblica SOLO il font
 * variabile (`IBMPlexSans[wdth,wght].ttf`), non build statiche per peso —
 * a differenza di Mono, che le pubblica entrambe. **Quello che mancava non
 * era il font, era il posto giusto dove cercarlo**: il SERVIZIO di download
 * di Google Fonts (diverso dal repo sorgente) genera lui stesso le istanze
 * statiche per peso da quel font variabile — lo stesso file che scaricherebbe
 * chi preme "Download family" sul sito — ed è quello usato qui. Verificato
 * scaricando i quattro pesi e leggendone il nome PostScript con `fontTools`
 * prima di committarli, non assunto.
 *
 * ⚠️ Nessuna build nativa gira in questa sessione: la resa reale del font va
 * verificata sul telefono del maintainer (vedi l'elenco di verifica in
 * `README.md`).
 */
export const fontFamily = {
  sans: "IBMPlexSans-Regular",
  sansMedium: "IBMPlexSans-Medium",
  sansSemiBold: "IBMPlexSans-SemiBold",
  sansBold: "IBMPlexSans-Bold",
  mono: "IBMPlexMono-Regular",
  monoMedium: "IBMPlexMono-Medium",
  monoSemiBold: "IBMPlexMono-SemiBold",
  monoBold: "IBMPlexMono-Bold",
} as const;

/**
 * Dimensioni ricorrenti nel canvas: etichette mono maiuscole (11), corpo
 * (14–15), titoli di schermata (24). Non un sistema tipografico completo —
 * solo ciò che i componenti di questo task usano davvero (YAGNI).
 */
export const fontSize = {
  label: 11,
  body: 14,
  input: 15,
  title: 24,
} as const;

/**
 * Preset di stile testo condivisi (Task 7, App M1+M2, 11 set 2026).
 *
 * Nascono da un'istruzione esplicita del maintainer dopo il Task 2: applicare
 * il Sans a un solo titolo era la scelta prudente per quel task, ma senza una
 * struttura il problema "quaranta `fontFamily` sparsi, uno sbagliato a mano"
 * si sarebbe ripresentato quando il Task 7 lo estende a ogni schermata — "è
 * la struttura che impedisce al problema di tornare". Un piccolo insieme, non
 * un sistema tipografico: SOLO ciò che `ScreenHeader` (e finché resta
 * l'unico bisogno, nient'altro) usa davvero. `screenTitle` è esattamente lo
 * stile che aveva `InboxScreen.tsx` prima di questo task — nessuna resa
 * cambia per l'Inbox, cambia solo che ora è un preset condiviso invece di
 * essere l'unica copia manuale.
 */
export const textStyles = {
  screenTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: fontSize.title,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  screenSubtitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
} as const;
