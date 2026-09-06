/**
 * Font del design: IBM Plex Sans (corpo, titoli) e IBM Plex Mono (etichette
 * maiuscole, wordmark, badge, cifre) — vedi il canvas.
 *
 * ⚠️ GAP NOTO, VERIFICATO — non un dettaglio dimenticato:
 *
 * - **Mono**: i `.ttf` in `apps/mobile/assets/fonts/` sono VERI, non
 *   fabbricati — scaricati dal mirror ufficiale di Google Fonts
 *   (`github.com/google/fonts`, OFL-1.1, licenza in `assets/fonts/OFL.txt`),
 *   che per IBM Plex Mono pubblica ancora build STATICHE per peso (a
 *   differenza del pacchetto npm `@ibm/plex-mono`, che spedisce solo
 *   `.woff`/`.woff2` — verificato scompattando il tarball). PostScript name
 *   verificato con `fontTools` prima di committare: `IBMPlexMono-Regular`,
 *   `-Medium`, `-SemiBold`, `-Bold`, tutti distinti — è la stringa che va in
 *   `fontFamily`.
 * - **Sans**: Google Fonts distribuisce IBM Plex Sans SOLO come font
 *   variabile (`IBMPlexSans[wdth,wght].ttf`, un solo file con asse `wght`),
 *   e non esiste un pacchetto npm con build statiche vere (verificato:
 *   `@ibm/plex-mono`/`@ibm/plex` spediscono solo woff; il repo sorgente
 *   `github.com/IBM/plex` non committa binari, li genera con una toolchain).
 *   Estrarre un'istanza statica con `fonttools varLib.instancer` è FATTIBILE
 *   ma introdurrebbe un font MAI verificato su un build nativo reale, per un
 *   dettaglio tipografico — non ne vale il rischio ora. Si usa perciò il sans
 *   di SISTEMA (San Francisco su iOS, Roboto su Android): `fontFamily:
 *   undefined` lascia scegliere alla piattaforma, e `fontWeight` continua a
 *   funzionare nativamente. Debito noto: se in futuro arriva una build
 *   statica affidabile di IBM Plex Sans, questo è l'unico file da toccare.
 */
export const fontFamily = {
  /** Sans di sistema: nessun file custom, vedi il commento sopra. */
  sans: undefined,
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
