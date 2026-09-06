import en from "./en.json";
import it from "./it.json";

/**
 * Raccoglie tutti i percorsi (`a.b.c`) delle foglie stringa di un oggetto
 * annidato, ricorsivamente. Serve a confrontare it/en SENZA inchiodare il
 * test al contenuto delle stringhe (che deve poter differire) o alla loro
 * profondità esatta scritta a mano.
 */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value === "string") return [prefix];
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  // Una foglia non-stringa (numero, booleano, array…) non ha senso in un
  // catalogo di traduzioni: la si segnala come percorso a sé, così un test
  // che confronta i percorsi la scova comunque invece di ignorarla in silenzio.
  return [prefix];
}

test("it.json e en.json hanno esattamente le stesse chiavi", () => {
  const itPaths = leafPaths(it).sort();
  const enPaths = leafPaths(en).sort();

  const onlyInIt = itPaths.filter((path) => !enPaths.includes(path));
  const onlyInEn = enPaths.filter((path) => !itPaths.includes(path));

  expect({ onlyInIt, onlyInEn }).toEqual({ onlyInIt: [], onlyInEn: [] });
});

test("nessuna stringa vuota nei due cataloghi", () => {
  const emptyIt = leafPaths(it).filter((path) => {
    const value = path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], it);
    return value === "";
  });
  const emptyEn = leafPaths(en).filter((path) => {
    const value = path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], en);
    return value === "";
  });
  expect({ emptyIt, emptyEn }).toEqual({ emptyIt: [], emptyEn: [] });
});
