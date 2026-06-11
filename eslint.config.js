import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // **/.astro/ contiene i tipi generati da Astro (docs Starlight); non è
    // codice nostro e non va lintato.
    ignores: ["**/dist/", "**/node_modules/", "**/coverage/", "**/.astro/"],
  },
  ...tseslint.configs.recommended
);
