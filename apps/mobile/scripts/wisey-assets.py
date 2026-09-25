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
  gufo-<fase>-button[@2x/@3x].png il gufo del cerchio sopra la barra (42×36 pt)

IL GUFO DEL CERCHIO (25 set 2026, design §11): sta dentro il bottone da 64 pt
che sporge sopra la barra, a 42×36 pt per fotogramma, cioè 0,75 del disegno.
Nessun fattore è intero (0,75×, 1,5×, 2,25×), quindi si fa come la variante
(b) della tab, scelta dal maintainer: NEAREST a 3× (intero, senza perdita) e
poi LANCZOS alla misura, fotogramma per fotogramma — ridurre la striscia
intera mescolerebbe i bordi di due fotogrammi vicini.
  wisey-tab-empty[@2x/@3x].png    l'icona della tab NATIVA di Wisey: trasparente

LA TAB NATIVA È TRASPARENTE (25 set 2026, design §11): Wisey nella barra è
ora il cerchio nostro che sporge sopra, col gufo del cerchio qui sopra. La
tab nativa resta (le altre quattro tengono il loro posto), con un'icona che
non disegna niente, alla misura di un'icona di tab.

Prima (design §10) l'icona nativa era il gufo stesso, animato cambiandole
immagine a ogni fotogramma: 4 fotogrammi per fase, 28×24 pt più 3 pt di
margine, variante morbida a @3x — scelta al telefono fra una NEAREST a 1,5×
(netta ma irregolare) e NEAREST a 3× poi LANCZOS (fedele). Quel meccanismo è
stato tolto col §11; la riduzione morbida vive nel gufo del cerchio.

Rieseguibile: riscrive solo i file generati.
Uso: python3 apps/mobile/scripts/wisey-assets.py
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "wisey"
PHASES = ["riposo", "ascolta", "pensa", "lavora", "parla", "fatto"]
# Il gufo dentro il cerchio sopra la barra, in punti per fotogramma (vedi il docblock).
BUTTON_FRAME_PT = (42, 36)



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
        write_button_sprite(source, f"gufo-{phase}-button")
    write_empty_tab_icon()


def write_button_sprite(strip: Image.Image, stem: str) -> None:
    """La striscia del gufo del cerchio: 4 fotogrammi da 42×36 pt, alle tre densità."""
    for density, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        width, height = BUTTON_FRAME_PT[0] * density, BUTTON_FRAME_PT[1] * density
        out = Image.new("RGBA", (width * 4, height), (0, 0, 0, 0))
        for index in range(4):
            frame = strip.crop((56 * index, 0, 56 * (index + 1), 48))
            big = frame.resize((168, 144), Image.NEAREST)
            out.paste(big.resize((width, height), Image.LANCZOS), (width * index, 0))
        out.save(ASSETS / f"{stem}{suffix}.png", optimize=True)


def write_empty_tab_icon() -> None:
    """L'icona trasparente della tab nativa: 28×24 pt, nessun pixel visibile."""
    for density, suffix in ((1, ""), (2, "@2x"), (3, "@3x")):
        Image.new("RGBA", (28 * density, 24 * density), (0, 0, 0, 0)).save(
            ASSETS / f"wisey-tab-empty{suffix}.png", optimize=True
        )

if __name__ == "__main__":
    main()
