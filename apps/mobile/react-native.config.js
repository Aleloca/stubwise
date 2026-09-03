/**
 * Font custom da linkare nei progetti nativi (`npx react-native-asset`, poi
 * `pod install`): i quattro pesi IBM Plex Mono in `assets/fonts/` — vedi il
 * commento in `src/theme/typography.ts` per il perché non c'è IBM Plex Sans
 * (nessuna build statica affidabile, si usa il sans di sistema).
 */
module.exports = {
  assets: ["./assets/fonts"],
};
