---
name: Stubwise Desktop
description: A numbered catalog for company work - flat hairline surfaces, citable codes, color only where it means something.
colors:
  ground-dark: "oklch(0.185 0.004 265)"
  surface-dark: "oklch(0.215 0.004 265)"
  rail-dark: "oklch(0.16 0.004 265)"
  ink-dark: "oklch(0.965 0.006 85)"
  ink-muted-dark: "oklch(0.76 0.006 265)"
  ink-faint-dark: "oklch(0.64 0.006 265)"
  focus-dark: "oklch(0.74 0.13 250)"
  critical-dark: "oklch(0.7 0.17 22)"
  warning-dark: "oklch(0.8 0.14 75)"
  positive-dark: "oklch(0.74 0.14 158)"
  ground-light: "oklch(0.982 0.002 265)"
  surface-light: "oklch(1 0 0)"
  rail-light: "oklch(0.958 0.003 265)"
  ink-light: "oklch(0.2 0.005 265)"
  ink-muted-light: "oklch(0.44 0.006 265)"
  ink-faint-light: "oklch(0.53 0.006 265)"
  focus-light: "oklch(0.52 0.19 258)"
  critical-light: "oklch(0.54 0.2 25)"
  warning-light: "oklch(0.56 0.12 70)"
  positive-light: "oklch(0.52 0.12 158)"
  logo-amber: "#f5a623"
  logo-ground: "#0f1318"
  dept-1-dark: "oklch(0.87 0.16 118)"
  dept-2-dark: "oklch(0.6 0.17 258)"
  dept-3-dark: "oklch(0.76 0.15 145)"
  dept-4-dark: "oklch(0.68 0.18 32)"
  dept-5-dark: "oklch(0.53 0.17 300)"
  dept-6-dark: "oklch(0.76 0.1 200)"
  dept-7-dark: "oklch(0.68 0.18 345)"
  dept-8-dark: "oklch(0.72 0.04 250)"
  dept-1-light: "oklch(0.62 0.14 118)"
  dept-2-light: "oklch(0.44 0.19 260)"
  dept-3-light: "oklch(0.55 0.14 145)"
  dept-4-light: "oklch(0.49 0.16 32)"
  dept-5-light: "oklch(0.37 0.17 300)"
  dept-6-light: "oklch(0.56 0.09 210)"
  dept-7-light: "oklch(0.52 0.2 350)"
  dept-8-light: "oklch(0.54 0.04 250)"
typography:
  title:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: "34px"
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "26px"
  project-name:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "22px"
  body:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  body-sm:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    lineHeight: "18px"
  label:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    letterSpacing: "0.08em"
    fontFeature: "font-stretch 118%, uppercase"
  code:
    fontFamily: "Archivo Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    letterSpacing: "0.02em"
    fontFeature: "tnum"
rounded:
  hairline: "1px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  base: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "32px"
components:
  rail:
    backgroundColor: "{colors.rail-dark}"
    width: "64px"
  project-column:
    backgroundColor: "{colors.surface-dark}"
    width: "240px"
  rail-control:
    textColor: "{colors.ink-muted-dark}"
    rounded: "{rounded.lg}"
    size: "40px"
  project-tile:
    textColor: "{colors.ink-muted-dark}"
    rounded: "{rounded.lg}"
    size: "40px"
  column-item:
    textColor: "{colors.ink-muted-dark}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
  detail-panel:
    backgroundColor: "{colors.surface-dark}"
    width: "360px"
  notifications-panel:
    backgroundColor: "{colors.surface-dark}"
    width: "400px"
  command-palette:
    backgroundColor: "{colors.surface-dark}"
    rounded: "{rounded.xl}"
    width: "640px"
  menu:
    backgroundColor: "{colors.surface-dark}"
    rounded: "{rounded.lg}"
    padding: "6px"
  logo:
    backgroundColor: "{colors.logo-ground}"
    textColor: "{colors.logo-amber}"
    rounded: "{rounded.lg}"
    size: "32px"
---

# Design System: Stubwise Desktop

## Overview

**Creative North Star: "The Numbered Catalog"**

Every citable thing - a task, a docs page, a drive file, an automation, an incoming event - is a catalog entry with a code you can paste anywhere. The code anchors the row; the name is always readable beside it, never replaced by it. Surfaces are flat, separated by thin hairline rules instead of boxes, and the screen stays calm so the few solid colors that appear can mean something.

Dark is the cover: opaque near-black with warm white ink, never pure black. Light is its negative: neutral paper (not cream) with near-black ink. One precise grotesque (Archivo) does all the work, using tabular figures for codes, dates and counts. Color encodes department or state and is never decoration.

The built layout diverges from the early contract sketch (236px sidebar): it ships as a 64px rail, a 240px context column and a work area, with an optional docked 360px detail panel.

**Key Characteristics:**
- Flat surfaces; hairlines (`rule`, `rule-strong`) do the work of boxes.
- Code-first rows: code in tabular figures, name always beside it.
- Department color is the one structural color, shown as an inset 3px strip on task rows only.
- Signals that are not department or status are ink: solid dot for "waiting on you" and "unread".
- One page-title system: 28px h1 on every destination.
- Motion 150-250ms, exponential ease-out, none under reduced motion.

## Colors

A near-monochrome neutral field (cool, hue 265, chroma under 0.01) with eight department hues and three status colors, all in OKLCH. Both themes are defined token-for-token in `styles/tokens.css`; names below use the frontmatter `-dark` / `-light` suffix.

### Primary
- **Ink** (`ink-dark` / `ink-light`): text, icons, and the neutral signals (waiting dot, unread dot, Claude ring, selection, caret, accent-color). Ink is the system's accent.

### Secondary
- **Focus Blue** (`focus-dark` / `focus-light`, hue 250-258): focus rings only. Never used as fill, link or selection, because a blue elsewhere reads as department 2.

### Tertiary
- **Brand Amber** (`logo-amber` on `logo-ground`): only the "S_" logo, in both themes. These two hex values are the only color literals outside the token file.
- **Critical / Warning / Positive** (red 22-25, amber 70-75, green 158): status only where it carries meaning (overdue, at risk, done).
- **Department colors 1-8** (`dept-*`): chartreuse 118, blue 258, green 145, red-orange 32, violet 300, cyan 200, magenta 345, slate 250 (low chroma). At least 3:1 against the ground in both themes; the first five also step in lightness (lightest to darkest: 1, 3, 4, 2, 5) so they separate without hue. Department 1 sits at hue 118, away from warning amber.

### Neutral
- **Ground / Surface / Rail**: the window field, columns and panels (surface), and the rail (darker than ground in both themes). Dark L 0.185 / 0.215 / 0.16; light 0.982 / 1.0 / 0.958.
- **Ink Muted / Ink Faint**: secondary and tertiary text; faint is the lowest legible tier.
- **Rule / Rule-strong**: ink at 11-12% / 20-24% alpha. Rule separates regions; rule-strong outlines floating surfaces and keycaps.
- **Scrim**: black 50% (dark) / ink 24% (light) behind the palette.

### Named Rules
**The Color-Means-Something Rule.** A solid color appears only as department (strip, legend swatch) or status. If a color is neither, it should be ink.

**The Hue-Neutral Claude Rule.** "Claude working" is ink, not a hue: no hue was at least 30 degrees clear of all eight departments and the statuses in both themes. Claude is told apart by shape (a 2px dashed pulsing ring), against the solid dot of "waiting on you".

**The Focus-Only Blue Rule.** `--focus` is for `:focus-visible` rings (2px, 2px offset) and nothing else.

**The Amber-On-The-Logo Rule.** Brand amber is the logo's alone.

## Typography

**Display / Body / Label Font:** Archivo Variable (with ui-sans-serif, system-ui, sans-serif)
**Mono:** none. `font-mono` is aliased to Archivo; the only monospace in the app is the "S_" logo.

**Character:** one precise grotesque carries everything. Weight and width, not a second family, make the hierarchy. Both the weight and width axes are loaded (width 62-125%).

### Hierarchy
- **Title** (600, 28px, 34px line, -0.01em): the single page title on every destination, and the project code at display scale in a project column header.
- **Headline** (600, 20px / 26px): section headings inside pages.
- **Project name** (600, 16px / 22px, clamped to two lines): beside the code in a project column header.
- **Body** (400, 14px / 20px): default text, list rows, menu items.
- **Body small** (13px / 18px): tooltips, secondary lines, notification bodies.
- **Label** (12px / 16px): metadata, dates, legends. Group headings use the `heading-group` style: 600, 12px, width 118%, 0.08em tracking, uppercase, ink-muted.
- **Code** (600, 12px, 0.02em, tabular figures): catalog codes on tiles, rows and notifications.

### Named Rules
**The Code-Beside-Name Rule.** A code is never alone: the name is always readable next to it. In column headers the code is at display scale and the name takes up to two lines.

**The Group-Heading-Only Rule.** Spaced, expanded, uppercase text is for short group headings (Overdue, Today, palette groups, menu groups), never for body or buttons.

**The Tabular Figures Rule.** Codes, dates and counts use tabular figures (`num`).

## Layout

A three-column grid: `64px 240px minmax(0,1fr)`. The 64px rail holds the logo, destinations, pinned project tiles, all-projects, and (pinned to the bottom) notifications, palette and profile. The 240px context column is a project column (header, section list, settings separated by a hairline) or a personal column; the work area scrolls. Details open as a docked 360px right panel with a left hairline; notifications open as a 400px overlay panel from the right. The top of the rail is a window drag region, with 36px reserved for macOS traffic lights.

Spacing is a 4px base (`--spacing: 4px`). Rail controls are 40px squares with 4px gaps; tiles have an 8px gap; the tile zone shows only whole tiles, with a "+N" overflow tile carrying the hidden tiles' signals. Column items are 32px high. Column headers use 16px side padding; placeholder pages 32px.

Personal destinations have no column title; the page's 28px h1 is the only title. No responsive breakpoints are defined: the desktop window is the target, and the palette and panels clamp with `max-width`.

## Elevation & Depth

Flat by default, tonal and hairline-led: depth is the step between rail, ground and surface plus a `rule` line. Hover, active and current states are ink tints (6%, 10%, 10%).

### Shadow Vocabulary
Soft ambient shadows exist only on floating, transient surfaces. This is what the code carries:
- **Tooltip** (`box-shadow: 0 4px 16px -4px oklch(0 0 0 / 0.35)`)
- **Profile menu** (`box-shadow: 0 12px 32px -8px oklch(0 0 0 / 0.4)`)
- **Command palette** (`box-shadow: 0 24px 48px -16px oklch(0 0 0 / 0.45)`)
- **Logo inset** (`inset 0 0 0 1px var(--rule-strong)`): an outline, not elevation.

The notifications panel and docked panels have no shadow: a `rule-strong` / `rule` left border alone.

### Named Rules
**The Hairline-Not-Shadow Rule.** Anything that lives in the page (columns, rows, docked panels, the notifications panel) is separated by a hairline. A shadow is permitted only for a surface that floats over the page momentarily, and it is soft and offset downward, never hard.

## Shapes

Quiet, small radii. Controls and tiles are 8px (`lg`); list items, tooltips and keycaps 6px (`md`); the command palette 12px (`xl`); dots and avatars fully round. The department strip is a 3px-wide bar with a 1px radius, inset 10px from the top and bottom of the row and flush at the left edge - never a colored border. Outlines are 1px `rule`; a floating surface or keycap uses `rule-strong`.

## Components

### Rail controls and project tiles
40px squares, 8px radius, `ink-muted` at rest. Hover tints ink 6%, active 10%, current page ink 10% with ink text. Project tiles add a 1px `rule` border (hover `rule-strong`, current ink at 40%) and show the project code in tabular figures. Tiles carry two signals: **waiting on you** is a solid ink dot (10px, 2px rail-colored border) at the top right; **Claude working** is a 2px dashed ink ring 4px outside the tile with a 12px radius, pulsing opacity 1 to 0.3 over 1.8s. Both have screen-reader text. Tooltips appear after 250ms with the name and shortcut.

### Project column
Header: project code at 28px, name at 16px up to two lines, kind in 12px muted, hairline below. Items are 32px high with 10px side padding and an `ink-faint` count right-aligned; the current item gets a 10% ink tint and medium weight. Settings is separated by a hairline.

### Task row and department strip
Rows are code-first. The strip appears only on task rows (department belongs to the task, not the project: no strips on projects or tiles). Each row carries a "Department: X" tooltip and a screen-reader label; each surface that shows strips also shows a legend of only the departments present, using the same 3px bar swatches at 12px high, in configured order, wrapping in narrow surfaces.

### Notifications panel
A 400px panel entering from the right. Each item: a fixed column holding an unread solid ink dot (8px, absent when read), the object code (tabular, 600) then secondary text and time, a 14px title that is semibold when unread, and a two-line body. Actions appear on hover or focus.

### Command palette
640px dialog 12vh from the top, 12px radius, `rule-strong` border, backdrop in `scrim`. 52px input row, grouped results with `heading-group` headings, keycaps as bordered chips.

### Profile menu
19rem popover to the right of the rail, 8px radius, `rule-strong` border, hairline-separated sections, theme radio group with ink `accent-color`.

## Do's and Don'ts

### Do:
- **Do** use ink, not hue, for any signal that is not a department or a status (waiting, unread, Claude working).
- **Do** put the code in tabular figures beside the name on every row, tile and notification.
- **Do** use the 3px inset strip plus a legend and a "Department: X" tooltip for department; carry the name in text too.
- **Do** separate in-page regions with `rule` hairlines (`rule-strong` for floating edges).
- **Do** keep transitions at 150-250ms with `cubic-bezier(0.16, 1, 0.3, 1)`, and zero them under `prefers-reduced-motion`.
- **Do** keep the 28px h1 as the single page title on every destination.

### Don't:
- **Don't** use `--focus` blue for anything but focus rings.
- **Don't** put brand amber anywhere except the "S_" logo.
- **Don't** show a department strip on projects, tiles or non-task rows.
- **Don't** use monospace (except the logo) or uppercase spaced text outside group headings.
- **Don't** box content in shadowed cards or add decorative gradients.
- **Don't** introduce a new hue for Claude or for state without checking a 30 degree gap from the eight departments.
