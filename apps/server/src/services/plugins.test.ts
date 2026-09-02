import { describe, expect, it } from "vitest";
import { derivePluginSlug } from "./plugins.js";

/**
 * Test PURI della derivazione dello slug: nessun DB, perché è la funzione che
 * decide un COMPONENTE DI PERCORSO sul volume del worker e merita di essere
 * interrogata da sola, con input ostili. Il comportamento sul DB (unicità,
 * job, abilitazioni) è nei test delle rotte, dove passa dall'API vera.
 */
describe("derivePluginSlug", () => {
  it("prende l'ultimo segmento del path dell'URL", () => {
    expect(derivePluginSlug("https://github.com/obra/superpowers")).toBe("superpowers");
    expect(derivePluginSlug("https://github.com/obra/superpowers/")).toBe("superpowers");
    expect(derivePluginSlug("https://github.com/obra/superpowers?x=1#y")).toBe("superpowers");
  });

  it("toglie il suffisso .git", () => {
    expect(derivePluginSlug("https://github.com/obra/superpowers.git")).toBe("superpowers");
  });

  it("normalizza maiuscole e separatori", () => {
    expect(derivePluginSlug("https://github.com/obra/Super_Powers.git")).toBe("super-powers");
    expect(derivePluginSlug("https://example.com/a/plugin.name.v2")).toBe("plugin-name-v2");
  });

  it("quando c'è una subdir, lo slug viene dal suo ultimo segmento", () => {
    expect(derivePluginSlug("https://github.com/obra/monorepo.git", "plugins/my-plugin")).toBe(
      "my-plugin",
    );
    expect(derivePluginSlug("https://github.com/obra/monorepo.git", "my-plugin")).toBe("my-plugin");
  });

  it("tronca a 64 caratteri senza lasciare trattini penzolanti", () => {
    const long = `${"a".repeat(70)}`;
    expect(derivePluginSlug(`https://example.com/x/${long}`)).toBe("a".repeat(64));
    // Il troncamento cade su un trattino: va tolto, non lasciato in coda.
    const cut = `${"a".repeat(63)}-bbbb`;
    expect(derivePluginSlug(`https://example.com/x/${cut}`)).toBe("a".repeat(63));
  });

  it("restituisce null quando non c'è nulla da cui derivare uno slug", () => {
    // Nessun segmento utile, o un segmento fatto solo di caratteri scartati:
    // meglio un rifiuto esplicito (400) che uno slug inventato.
    expect(derivePluginSlug("https://github.com")).toBeNull();
    expect(derivePluginSlug("https://github.com/")).toBeNull();
    expect(derivePluginSlug("https://github.com/obra/---")).toBeNull();
    expect(derivePluginSlug("https://github.com/obra/....git")).toBeNull();
    expect(derivePluginSlug("non-un-url")).toBeNull();
  });

  it("non lascia mai uscire lo slug dal pattern, nemmeno con input di traversal", () => {
    // Ogni riga è un tentativo di far diventare lo slug qualcosa che, appeso a
    // `<PLUGINS_DIR>/`, non sia più una sottodirectory.
    const hostile: Array<[string, string | undefined]> = [
      ["https://example.com/a/%2e%2e", undefined],
      ["https://example.com/a/%2e%2e%2f%2e%2e", undefined],
      ["https://example.com/a/..%2fetc%2fpasswd", undefined],
      ["https://example.com/a/%2fetc%2fpasswd", undefined],
      ["https://example.com/a/.", undefined],
      ["https://example.com/a/..", undefined],
      ["https://example.com/repo.git", ".."],
      ["https://example.com/repo.git", "a/../../etc"],
      ["https://example.com/repo.git", "..\\..\\etc"],
      ["https://example.com/a/%20%20", undefined],
      ["https://example.com/a/$(whoami)", undefined],
    ];
    for (const [url, subdir] of hostile) {
      const slug = derivePluginSlug(url, subdir);
      // O rifiuta, o produce qualcosa che resta dentro il pattern stretto.
      if (slug !== null) {
        expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
        expect(slug).not.toContain("/");
        expect(slug).not.toContain("..");
      }
    }
  });
});
