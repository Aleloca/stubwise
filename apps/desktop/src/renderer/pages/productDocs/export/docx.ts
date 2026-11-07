import {
  blockHeadingLevel,
  pageHeadingLevel,
  type ExportBlock,
  type ExportDoc,
  type ExportRun,
} from "../../../domain/productDocs/exportModel";

// Il Word dell'esportazione (area 11a, Task 12; ruling P36). Il renderer è
// `sandbox`, senza Node: nessun `Buffer`, l'uscita è un `ArrayBuffer`; le
// misure delle immagini si leggono dai byte d'intestazione (happy-dom non
// decodifica immagini, e non serve). `docx` pesa: si importa solo quando si
// costruisce. Le funzioni pure qui sopra non lo toccano.

/** Un pezzo di frase per il Word: `TextRun` (bold/italics) o, con `link`, un `ExternalHyperlink`. */
export interface DocxRun {
  text: string;
  bold: boolean;
  italics: boolean;
  link: string | null;
}

export function docxRunsOf(runs: ExportRun[]): DocxRun[] {
  return runs.map((r) => ({ text: r.text, bold: r.bold, italics: r.italic, link: r.href }));
}

/** Larghezza e altezza in pixel dai byte d'intestazione di una PNG, JPEG o GIF; `null` per il resto. */
export function imageSizeOf(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const u32be = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
  // PNG: firma di 8 byte, poi IHDR con larghezza e altezza.
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32be(16), height: u32be(20) };
  }
  // GIF: «GIF8», poi larghezza e altezza little-endian.
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
  }
  // JPEG: si scorrono i segmenti fino a un SOF (C0–CF tranne C4, C8, CC).
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(i + 7), height: u16be(i + 5) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}

const DOCX_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as const;

/** Un'immagine che il Word sa mettere (PNG, JPEG, GIF da un `data:` URL); `null` = la sola didascalia (WebP e il resto). */
export function docxImageOf(
  src: string,
): { type: "png" | "jpg" | "gif"; data: Uint8Array; width: number; height: number } | null {
  const match = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(src);
  if (!match) return null;
  const type = DOCX_TYPES[match[1] as keyof typeof DOCX_TYPES];
  if (!type) return null;
  let data: Uint8Array;
  try {
    data = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const size = imageSizeOf(data);
  return size && size.width > 0 && size.height > 0 ? { type, data, ...size } : null;
}

/**
 * Perché un'immagine resta fuori dal Word: il suo formato (WebP, SVG, …)
 * oppure un `src` che non è un'immagine `data:`. Un valore stabile: la frase
 * la compone l'avviso, in en o it.
 */
export type WordLeftOut = { format: string } | { notData: true };

const FORMAT_LABELS: Record<string, string> = { webp: "WebP", "svg+xml": "SVG", jpeg: "JPEG" };

function leftOutReasonOf(src: string): WordLeftOut | null {
  if (docxImageOf(src) !== null) return null;
  const subtype = /^data:image\/([a-z0-9.+-]+)[;,]/i.exec(src)?.[1]?.toLowerCase();
  if (!subtype) return { notData: true };
  return { format: FORMAT_LABELS[subtype] ?? subtype.replace(/\+.*$/, "").toUpperCase() };
}

/** Le immagini che il Word lascia fuori, nell'ordine del documento, ciascuna col suo motivo. */
export function wordLeftOutReasons(doc: ExportDoc): WordLeftOut[] {
  return doc.pages.flatMap((p) =>
    p.blocks.flatMap((b) => {
      const reason = b.kind === "image" ? leftOutReasonOf(b.src) : null;
      return reason ? [reason] : [];
    }),
  );
}

/** Quante immagini il Word lascia fuori (l'avviso finale le conta). */
export function wordLeftOutImages(doc: ExportDoc): number {
  return wordLeftOutReasons(doc).length;
}

/** La larghezza utile di un A4 coi margini di Word, in pixel a 96 dpi. */
const MAX_IMAGE_WIDTH = 600;

/** Una PNG pronta per il Word: i byte e le misure in pixel. */
export interface DocxPng {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Le frasi e la conversione delle bozze di schermata (11b, Task 12; shape
 * product-claude-backlog.md §3.7, P36): l'etichetta «Claude's draft · Screen
 * sketch» composta da chi esporta nella sua lingua (solo sotto uno schizzo
 * mai tenuto), la riga di un disegno che il seme non ha più, e lo schizzo
 * SVG fatto PNG (`svgToPng`; i test ne passano un doppio).
 */
export interface DocxSketches {
  label: string;
  /** Il nome dell'immagine di uno schizzo tenuto («Screen sketch»): una figura come le altre. */
  name: string;
  gone: string;
  /** Lo schizzo che non si è potuto fare PNG: una riga che lo dice, al suo posto (fix round 1, M4). */
  missing: string;
  toPng: (svg: string) => Promise<DocxPng | null>;
}

/**
 * Lo schizzo SVG del seme come PNG per il Word: linee nere su bianco, anche
 * nel tema scuro (le linee sono `currentColor`), larga `width` pixel. `null`
 * dove il renderer non sa disegnarla (nessuna tela: il Word avrà la sola
 * etichetta).
 */
export async function svgToPng(svg: string, width = MAX_IMAGE_WIDTH * 2): Promise<DocxPng | null> {
  try {
    const box = /viewBox="\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
    const w = box ? Number(box[1]) : 360;
    const h = box ? Number(box[2]) : 240;
    const height = Math.round((width * h) / w);
    const black = svg.replace(/currentColor/g, "#000");
    const img = new Image(width, height);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(black)}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    if (!blob) return null;
    return { data: new Uint8Array(await blob.arrayBuffer()), width, height };
  } catch {
    return null;
  }
}

export async function buildDocx(doc: ExportDoc, sketches?: DocxSketches): Promise<Uint8Array> {
  // Le PNG delle bozze prima di costruire (la costruzione dei blocchi è sincrona).
  const pngs = new Map<string, DocxPng | null>();
  for (const page of doc.pages)
    for (const b of page.blocks)
      if (b.kind === "sketch" && b.svg !== null && !pngs.has(b.svg))
        pngs.set(b.svg, sketches ? await sketches.toPng(b.svg) : null);
  const d = await import("docx");
  const HEADINGS = [
    d.HeadingLevel.TITLE,
    d.HeadingLevel.HEADING_1,
    d.HeadingLevel.HEADING_2,
    d.HeadingLevel.HEADING_3,
    d.HeadingLevel.HEADING_4,
    d.HeadingLevel.HEADING_5,
    d.HeadingLevel.HEADING_6,
  ] as const;

  const children = (runs: ExportRun[]) =>
    docxRunsOf(runs).map((r) => {
      const text = new d.TextRun({ text: r.text, bold: r.bold, italics: r.italics, style: r.link ? "Hyperlink" : undefined });
      return r.link ? new d.ExternalHyperlink({ link: r.link, children: [text] }) : text;
    });

  // Ogni elenco numerato riparte da 1: un'istanza della numerazione per ogni fila.
  let orderedInstance = 0;
  let inOrdered = false;

  const blockOf = (b: ExportBlock, depth: number): (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] => {
    if (!(b.kind === "list" && b.ordered)) inOrdered = false;
    switch (b.kind) {
      case "heading":
        return [new d.Paragraph({ heading: HEADINGS[blockHeadingLevel(doc, depth, b.level)], children: children(b.runs) })];
      case "paragraph":
        return [new d.Paragraph({ children: children(b.runs) })];
      case "quote":
        return [
          new d.Paragraph({
            children: children(b.runs),
            indent: { left: 567 },
            border: { left: { style: d.BorderStyle.SINGLE, size: 12, color: "999999", space: 8 } },
          }),
        ];
      case "list":
        if (!b.ordered) return [new d.Paragraph({ bullet: { level: b.indent }, children: children(b.runs) })];
        if (!inOrdered) orderedInstance += 1;
        inOrdered = true;
        return [
          new d.Paragraph({
            numbering: { reference: "ordered", level: b.indent, instance: orderedInstance },
            children: children(b.runs),
          }),
        ];
      case "todo":
        return [new d.Paragraph({ children: [new d.TextRun(b.checked ? "☑ " : "☐ "), ...children(b.runs)] })];
      case "divider":
        return [
          new d.Paragraph({
            border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } },
          }),
        ];
      case "table":
        return [
          new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: b.rows.map(
              (row) =>
                new d.TableRow({
                  children: row.map((cell) => new d.TableCell({ children: [new d.Paragraph({ children: children(cell) })] })),
                }),
            ),
          }),
        ];
      case "image": {
        const caption = b.caption.trim()
          ? [new d.Paragraph({ children: [new d.TextRun({ text: b.caption, italics: true })] })]
          : [];
        const image = docxImageOf(b.src);
        if (!image) return caption;
        const scale = Math.min(1, MAX_IMAGE_WIDTH / image.width);
        return [
          new d.Paragraph({
            children: [
              new d.ImageRun({
                type: image.type,
                data: image.data,
                transformation: { width: Math.round(image.width * scale), height: Math.round(image.height * scale) },
                altText: { name: b.caption || "image", description: b.caption, title: b.caption },
              }),
            ],
          }),
          ...caption,
        ];
      }
      case "line":
        return [new d.Paragraph({ children: [new d.TextRun(b.line)] })];
      case "sketch": {
        // A tutta larghezza; sotto, in corsivo 10 pt, l'etichetta di uno schizzo mai tenuto (§3.7).
        const png = b.svg !== null ? (pngs.get(b.svg) ?? null) : null;
        const label = b.label && sketches ? [new d.Paragraph({ children: [new d.TextRun({ text: sketches.label, italics: true, size: 20 })] })] : [];
        if (!png) {
          // Mai in silenzio: un disegno sparito o uno schizzo che non è diventato PNG lo dicono al suo posto.
          const text = sketches ? (b.svg === null ? sketches.gone : sketches.missing) : null;
          const line = text ? [new d.Paragraph({ children: [new d.TextRun({ text, italics: true })] })] : [];
          return [...line, ...label];
        }
        const scale = Math.min(1, MAX_IMAGE_WIDTH / png.width);
        const alt = sketches ? (b.label ? sketches.label : sketches.name) : "";
        return [
          new d.Paragraph({
            children: [
              new d.ImageRun({
                type: "png",
                data: png.data,
                transformation: { width: Math.round(png.width * scale), height: Math.round(png.height * scale) },
                altText: { name: alt || "sketch", description: alt, title: alt },
              }),
            ],
          }),
          ...label,
        ];
      }
    }
  };

  const body: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [
    new d.Paragraph({ heading: d.HeadingLevel.TITLE, children: [new d.TextRun(doc.title)] }),
  ];
  doc.pages.forEach((page, i) => {
    const level = pageHeadingLevel(doc, page.depth);
    if (level !== null) {
      body.push(
        new d.Paragraph({
          heading: HEADINGS[level],
          pageBreakBefore: i > 0,
          children: [new d.TextRun(page.title)],
        }),
      );
    }
    body.push(new d.Paragraph({ children: [new d.TextRun({ text: page.code, color: "666666", size: 18 })] }));
    for (const b of page.blocks) body.push(...blockOf(b, page.depth));
    inOrdered = false;
  });

  const document = new d.Document({
    creator: "Stubwise",
    title: doc.title,
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: body }],
  });
  return new Uint8Array(await d.Packer.toArrayBuffer(document));
}
