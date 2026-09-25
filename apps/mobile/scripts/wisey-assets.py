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
  wisey-tab-<fase>-<n>[@2x/@3x].png  l'icona della tab: 4 fotogrammi per fase

L'ICONA SI ANIMA (25 set 2026, design §10): la barra nativa non anima
immagini, quindi l'app le cambia l'icona a ogni fotogramma, sulla stessa fase
del gufo grande. Ogni fotogramma di ogni fase diventa un'icona a sé, fatta
come quella che segue — la tela, la variante morbida, il margine.

L'ICONA DELLA TAB (25 set 2026, dopo due prove sul telefono): all'inizio era
il solo PRIMO fotogramma di `gufo-riposo.png` — il gufo Classic della 5a, 56×48 — e non
`owl-minimal.png`, che il maintainer ha scartato. Nella barra il gufo sta a
28×24 pt, cioè a METÀ del disegno:

  @2x = 56×48 px  → il fotogramma 1:1, nessuna scala, perfetto;
  @3x = 84×72 px  → 1,5 pixel per pixel del disegno: NON intero.

Con un fattore non intero nessuna scala è perfetta. Ne sono state provate
due sul telefono: NEAREST a 1,5× (pixel netti ma irregolari: metà dei pixel
del disegno diventano 1 px e metà 2 px, e le linee sottili raddoppiano o
spariscono a seconda della posizione) e quella tenuta, scelta dal
maintainer: NEAREST a 3× (168×144, intero, nessuna perdita) e poi LANCZOS a
84×72 — forme fedeli, bordi un poco morbidi. Il 1× (28×24, schermi a
densità 1, in pratica solo Android) è una riduzione LANCZOS: a metà misura
nessuna scala nearest tiene il disegno.

IL MARGINE SOTTO: nel fotogramma il gufo occupa (2,2)-(54,47), cioè arriva a
1 px dal bordo inferiore, mentre gli SF Symbol delle altre tab hanno aria
intorno — sul telefono il gufo toccava la scritta «WISEY». La tela è quindi
più ALTA del gufo di `TAB_BOTTOM_MARGIN_PT`, trasparente, col gufo in alto e
alla sua misura: si aggiunge spazio, non si rimpicciolisce il disegno.

Rieseguibile: riscrive solo i file generati.
Uso: python3 apps/mobile/scripts/wisey-assets.py
"""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parent.parent / "assets" / "wisey"
PHASES = ["riposo", "ascolta", "pensa", "lavora", "parla", "fatto"]
# Il gufo dentro il cerchio sopra la barra, in punti per fotogramma (vedi il docblock).
BUTTON_FRAME_PT = (42, 36)

# Spazio trasparente sotto il gufo della tab, in punti (vedi il docblock).
TAB_BOTTOM_MARGIN_PT = 3


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
    write_tab_icons()


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


def write_tab_icons() -> None:
    """Le icone della tab: 4 fotogrammi per fase, 28×24 pt più il margine (vedi il docblock)."""
    for phase in PHASES:
        strip = Image.open(ASSETS / f"gufo-{phase}.png").convert("RGBA")
        for index in range(4):
            write_tab_icon(strip.crop((56 * index, 0, 56 * (index + 1), 48)), f"wisey-tab-{phase}-{index}")


def write_tab_icon(frame: Image.Image, stem: str) -> None:
    """UN fotogramma 56×48 come icona della tab, alle tre densità."""
    owls = {
        1: frame.resize((28, 24), Image.LANCZOS),
        2: frame,
        3: frame.resize((168, 144), Image.NEAREST).resize((84, 72), Image.LANCZOS),
    }
    for density, owl in owls.items():
        canvas = Image.new("RGBA", (28 * density, (24 + TAB_BOTTOM_MARGIN_PT) * density), (0, 0, 0, 0))
        canvas.paste(owl, (0, 0))
        suffix = "" if density == 1 else f"@{density}x"
        canvas.save(ASSETS / f"{stem}{suffix}.png", optimize=True)

if __name__ == "__main__":
    main()
