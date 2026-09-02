module.exports = {
  presets: ["module:@react-native/babel-preset"],
  // zod (dipendenza di @stubwise/shared) usa `export * as core from "..."`: il
  // preset React Native non include la trasformazione di quella sintassi, e
  // senza questo plugin il transform CommonJS di Metro fallisce sui sorgenti ESM
  // di zod.
  plugins: ["@babel/plugin-transform-export-namespace-from"],
};
