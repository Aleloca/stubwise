const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// La radice del monorepo pnpm.
const root = path.resolve(__dirname, "../..");

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // L'unica impostazione che serve davvero. Metro indicizza solo ciò che sta
  // sotto la project root (apps/mobile) e le watchFolders, e con pnpm i file
  // che l'app importa stanno FUORI da apps/mobile: i package del workspace
  // (packages/shared, raggiunto via symlink) e lo store node_modules/.pnpm da
  // cui arrivano react-native, @babel/runtime e le loro dipendenze. Senza
  // questa riga il bundle fallisce con "Unable to resolve module
  // @babel/runtime/...". I symlink Metro 0.87 li segue da sé (l'opzione
  // unstable_enableSymlinks non esiste più) e nodeModulesPaths non serve: dal
  // realpath di packages/shared la lookup gerarchica risale già allo store.
  watchFolders: [root],
  resolver: {
    // I git worktree del repo stanno in <root>/.worktrees/ e hanno ognuno il
    // proprio node_modules/.pnpm: senza questo, Metro lanciato dalla checkout
    // principale li crawlerebbe tutti. Il pattern è ancorato a `root` e NON
    // scritto come /\.worktrees\//: lanciato DA un worktree la project root sta
    // essa stessa sotto .worktrees/, e un pattern non ancorato bloccherebbe i
    // sorgenti dell'app.
    blockList: [new RegExp(`^${escapeRegExp(path.join(root, ".worktrees"))}/`)],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
