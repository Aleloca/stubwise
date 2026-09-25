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
  owl-minimal.png  28×24                           (l'icona della tab)

Generati accanto:
  gufo-<fase>@2x/@3x.png          il gufo piccolo (56×48 pt a fotogramma)
  gufo-<fase>-large[@2x/@3x].png  il gufo grande, mostrato a 2× (112×96 pt)
  owl-minimal@2x/@3x.png          l'icona della tab

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
    owl = Image.open(ASSETS / "owl-minimal.png").convert("RGBA")
    assert owl.size == (28, 24), f"owl-minimal.png: atteso 28×24, trovato {owl.size}"
    write(owl, "owl-minimal", 1)


if __name__ == "__main__":
    main()
