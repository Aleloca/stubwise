const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// La radice del monorepo pnpm. Metro deve poterla guardare (watchFolders) e
// risolvere da lì i package workspace, che in pnpm sono symlink dentro
// apps/mobile/node_modules verso packages/*.
const root = path.resolve(__dirname, "../..");

/**
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [root],
  resolver: {
    unstable_enableSymlinks: true,
    nodeModulesPaths: [path.resolve(__dirname, "node_modules"), path.resolve(root, "node_modules")],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
