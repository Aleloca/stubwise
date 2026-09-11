/**
 * Font custom da linkare nei progetti nativi (`npx react-native-asset`, poi
 * `pod install`): i quattro pesi IBM Plex Mono E, dall'App M1, i quattro pesi
 * IBM Plex Sans in `assets/fonts/` — vedi il commento in
 * `src/theme/typography.ts` per la provenienza (build statiche dal servizio
 * di download di Google Fonts, non dal repo sorgente).
 */
module.exports = {
  assets: ["./assets/fonts"],
};
