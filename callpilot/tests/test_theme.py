"""Theme tokens keep WCAG AA contrast in both themes (body text 4.5:1, UI edges and focus rings 3:1)."""

from callpilot.ui.theme import DARK, LIGHT, stylesheet


def _lum(h: str) -> float:
    h = h.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def _ratio(a: str, b: str) -> float:
    hi, lo = sorted((_lum(a), _lum(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def test_contrast_tokens_both_themes():
    for name, c in (("dark", DARK), ("light", LIGHT)):
        for surface in ("panel", "panel2", "bg"):
            assert _ratio(c["text"], c[surface]) >= 4.5, (name, "text", surface)
            assert _ratio(c["muted"], c[surface]) >= 4.5, (name, "muted", surface)
            assert _ratio(c["field_border"], c[surface]) >= 3.0, (name, "field_border", surface)
            assert _ratio(c["focus_on_fill"], c[surface]) >= 3.0, (name, "focus ring on filled buttons", surface)
        assert _ratio(c["accent"], c["panel"]) >= 3.0, (name, "checked box fill")
        assert _ratio("#FFFFFF", c["accent"]) >= 3.0, (name, "tick on the checked box")


def test_inputs_and_focus_use_the_strong_tokens():
    for name, c in (("dark", DARK), ("light", LIGHT)):
        css = stylesheet(name)
        assert f"border: 1px solid {c['field_border']}" in css, name
        assert f"QPushButton#primary:focus {{ border: 2px solid {c['focus_on_fill']}" in css, name
        assert "QPushButton#ghost:checked:focus" in css and "QCheckBox::indicator:checked" in css, name
