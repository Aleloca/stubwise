#!/usr/bin/env python3
"""
Le misure di Wisey per iOS/Android, pre-scalate NEAREST-NEIGHBOUR
(«Wisey, anteprima nell'app», design §7).

Perché esiste: iOS scala un'immagine con interpolazione, e la pixel art del
gufo si sfocherebbe. Qui ogni pixel del disegno diventa un quadrato pieno di
2 o 3 pixel, e Metro sceglie da sé il file @2x/@3x giusto per lo schermo:
a video non resta nessuna scala da fare.

Sorgenti (dall'export di design, in `assets/wisey/`, MAI riscritti):
  gufo-<fase>.png  224×48 = 4 fotogrammi da 56×48  (il gufo piccolo, 1×)

Generati accanto:
  gufo-<fase>@2x/@3x.png          il gufo piccolo (56×48 pt a fotogramma)
  gufo-<fase>-large[@2x/@3x].png  il gufo grande, mostrato a 2× (112×96 pt)
  wisey-tab-sharp[@2x/@3x].png    l'icona della tab, variante (a)
  wisey-tab-smooth[@2x/@3x].png   l'icona della tab, variante (b)

L'ICONA DELLA TAB (25 set 2026, dopo la prova sul telefono): è il PRIMO
fotogramma di `gufo-riposo.png` — il gufo Classic della 5a, 56×48 — e non
più `owl-minimal.png`, che il maintainer ha scartato. Nella barra sta a
28×24 pt, cioè a METÀ del disegno:

  @2x = 56×48 px  → il fotogramma 1:1, nessuna scala, perfetto;
  @3x = 84×72 px  → 1,5 pixel per pixel del disegno: NON intero.

Con un fattore non intero non esiste una scala perfetta, e le due scelte
sbagliano in modo diverso, quindi si generano entrambe e decide il telefono:

  (a) `sharp`:  NEAREST a 1,5× — pixel netti ma irregolari (metà dei pixel
      del disegno diventano 1 px, l'altra metà 2 px: le linee sottili possono
      raddoppiare o sparire a seconda della posizione);
  (b) `smooth`: NEAREST a 3× (168×144, intero, nessuna perdita) e poi
      LANCZOS a 84×72 — forme fedeli, bordi un poco morbidi.

Le due varianti hanno lo stesso 1× e lo stesso @2x: differiscono SOLO a
@3x. Quale va nella barra lo dice UNA costante,
`src/app/wisey-tab-icon.ts`. Il 1× (28×24, schermi a densità 1, in pratica
solo Android) è una riduzione LANCZOS: a metà misura nessuna scala nearest
tiene il disegno.

Rieseguibile: riscrive solo i file generati.
Uso: python3 apps/mobile/scripts/wisey-assets.py
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "wisey"
PHASES = ["riposo", "ascolta", "pensa", "lavora", "parla", "fatto"]


def scaled(source: Image.Image, factor: int) -> Image.Image:
    return source.resize((source.width * factor, source.height * factor), Image.NEAREST)


def write(source: Image.Image, stem: str, base_factor: int) -> None:
    """`stem.png` a `base_factor`, poi @2x e @3x di quella misura."""
    for density, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        if base_factor == 1 and density == 1:
            continue  # il sorgente stesso: non si riscrive
        scaled(source, base_factor * density).save(ASSETS / f"{stem}{suffix}.png", optimize=True)


def main() -> None:
    for phase in PHASES:
        source = Image.open(ASSETS / f"gufo-{phase}.png").convert("RGBA")
        assert source.size == (224, 48), f"gufo-{phase}.png: atteso 224×48, trovato {source.size}"
        write(source, f"gufo-{phase}", 1)
        write(source, f"gufo-{phase}-large", 2)
    write_tab_icon()


def write_tab_icon() -> None:
    """L'icona della tab: primo fotogramma di riposo, 28×24 pt (vedi il docblock)."""
    frame = Image.open(ASSETS / "gufo-riposo.png").convert("RGBA").crop((0, 0, 56, 48))
    one_x = frame.resize((28, 24), Image.LANCZOS)
    sharp_3x = frame.resize((84, 72), Image.NEAREST)
    smooth_3x = frame.resize((168, 144), Image.NEAREST).resize((84, 72), Image.LANCZOS)
    for variant, three_x in (("sharp", sharp_3x), ("smooth", smooth_3x)):
        stem = f"wisey-tab-{variant}"
        one_x.save(ASSETS / f"{stem}.png", optimize=True)
        frame.save(ASSETS / f"{stem}@2x.png", optimize=True)
        three_x.save(ASSETS / f"{stem}@3x.png", optimize=True)


if __name__ == "__main__":
    main()
