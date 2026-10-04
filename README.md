# Courtesy Cars UK

## ClaimDesk claims platform

The accident claims, credit hire and accident management system lives in [`claimdesk/`](claimdesk/README.md). Start there.

---

## Print-ready logo

Vector rebuild of the Courtesy Cars UK logo for shop signage and print.

## Files (`print/`)

| File | Use |
|---|---|
| `courtesy-cars-uk-logo.pdf` | **Send this to the sign maker.** Pure vector, scales to any size with no loss. |
| `courtesy-cars-uk-logo.eps` | Vector, for older sign/vinyl-cutting software. |
| `courtesy-cars-uk-logo.svg` | Vector, for web or for editing (Illustrator, Inkscape, CorelDRAW). |
| `courtesy-cars-uk-logo-3000dpi-transparent.png` | 30000 × 5940 px, 3000 DPI, transparent background. |
| `courtesy-cars-uk-logo-3000dpi-white.png` | 30000 × 5940 px, 3000 DPI, white background. |
| `courtesy-cars-uk-logo-preview.png` | Small preview. |

All text is converted to outlines, so the printer does not need any fonts.

**About resolution:** the PDF, EPS and SVG files are vector, so they have no DPI. They stay razor-sharp at any size, from a business card to a 10 m fascia. The 3000 DPI PNG is 254 mm (10 in) wide at 3000 DPI. The same file is still about 150 DPI at 5 m wide, which is plenty for a sign viewed from the street.

## Colours

The CMYK and Pantone values are close matches only. Ask your printer to proof against a swatch.

| Name | HEX | RGB | CMYK (approx.) | Nearest Pantone (approx.) |
|---|---|---|---|---|
| Navy | `#072647` | 7 38 71 | 100 80 35 45 | 289 C |
| Blue | `#1466D2` | 20 102 210 | 85 55 0 0 | 2727 C / 285 C |
| Grey | `#A9A9A9` | 169 169 169 | 0 0 0 40 | Cool Gray 6 C |

The inner blue arc and the top of the road have a subtle blue gradient, as in the original.

## Fonts (SIL Open Font License)

- Headline: Archivo (Black, narrow width)
- Tagline and service labels: Barlow Semi Condensed Medium

## Rebuilding

```
pip install fonttools pillow numpy scipy scikit-image cairosvg
python3 build/build_logo.py
```
