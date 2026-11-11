/**
 * I tetti dell'estrazione del contenuto (area 5, fetta 3; piano
 * `docs/plans/2026-11-11-integrazione-area5-fetta3-plan.md`, «L'estrazione»).
 * Il file è input NON fidato: ogni processo figlio ha memoria, cpu e tempo
 * limitati, e l'OCR pagine e pixel.
 */
export const EXTRACT_LIMITS = {
  /** Memoria virtuale di ogni figlio (`prlimit --as`). */
  childMemoryBytes: 1024 ** 3,
  /** Tempo per pagina OCR (tesseract) e per la conversione di un HEIC. */
  ocrPageMs: 60_000,
  /** Tempo dell'estrazione Office/ODF, nel suo worker_thread (review della F3). */
  officeMs: 60_000,
  /** Tempo di `pdfinfo` e `pdftotext`. */
  pdfTextMs: 30_000,
  /** Tempo del job intero: oltre, i figli si uccidono e ciò che c'è resta. */
  jobMs: 5 * 60_000,
  /** OCR al più sulle prime pagine. */
  ocrMaxPages: 30,
  /** Risoluzione massima di una pagina rasterizzata. */
  maxDpi: 300,
  /** Pixel massimi di un'immagine (o di una pagina) passata a tesseract. */
  maxPixels: 40_000_000,
  /** Lo stdout di ogni figlio. */
  childStdoutBytes: 8 * 1024 * 1024,
  /** Il testo estratto complessivo. */
  textMaxChars: 1_000_000,
  /** Sotto questi caratteri non bianchi, il testo di un PDF non basta e si passa all'OCR. */
  pdfTextMinChars: 20,
} as const;
