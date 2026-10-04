"""Premium dark/light styling (brand: navy #072647, blue #1466D2)."""

from __future__ import annotations

DARK = {
    "bg": "#0A1120", "panel": "#101A2E", "panel2": "#16233D", "border": "#22324F",
    "text": "#E8EEF8", "muted": "#8EA0BD", "accent": "#1F7BFF", "accent2": "#1466D2",
    "good": "#22C55E", "warn": "#F59E0B", "bad": "#EF4444", "agent": "#7DD3FC", "caller": "#FBBF24",
    "say": "#FFFFFF", "chip": "#1B2B4A", "bubble_caller": "#1E2D4D", "bubble_agent": "#12325A",
    "primary": "#1466D2", "primary_hover": "#0F57B8", "danger_bg": "#DC2626", "danger_hover": "#B91C1C",
    "bad_text": "#F87171",
    # field_border: input/list/checkbox edges, >= 3:1 on panel and panel2 (WCAG 1.4.11);
    # focus_on_fill: the focus ring on filled (blue/red/green) buttons, >= 3:1 against the surface around them
    "field_border": "#6A80A4", "focus_on_fill": "#FFFFFF",
}
LIGHT = {
    "bg": "#F4F7FB", "panel": "#FFFFFF", "panel2": "#EEF3FA", "border": "#D5DEEB",
    "text": "#0B1730", "muted": "#52617B", "accent": "#1466D2", "accent2": "#072647",
    "good": "#15803D", "warn": "#A34A07", "bad": "#B91C1C", "agent": "#0369A1", "caller": "#A34A07",
    "say": "#072647", "chip": "#E3ECF9", "bubble_caller": "#FFFFFF", "bubble_agent": "#DCEBFF",
    "primary": "#1466D2", "primary_hover": "#0F57B8", "danger_bg": "#B91C1C", "danger_hover": "#991B1B",
    "bad_text": "#B91C1C",
    "field_border": "#6B7C99", "focus_on_fill": "#072647",
}


def palette(name: str) -> dict:
    return LIGHT if name == "light" else DARK


def _drawn_png(name: str, draw) -> str:
    """Draw a small icon once into the app's cache folder and return its path for a stylesheet url().
    Drawn rather than shipped so it needs no image plugin in the packaged EXE; returns '' if it cannot be
    written, and the stylesheet then keeps Qt's own arrows/indicators."""
    try:
        from PySide6.QtCore import Qt
        from PySide6.QtGui import QImage, QPainter

        from callpilot.core import paths

        out = paths.sub_dir("cache") / name
        if not out.exists():
            img = QImage(48, 48, QImage.Format_ARGB32_Premultiplied)
            img.fill(Qt.transparent)
            qp = QPainter(img)
            qp.setRenderHint(QPainter.Antialiasing)
            draw(qp)
            qp.end()
            if not img.save(str(out), "PNG"):
                return ""
        return out.as_posix()
    except Exception:  # noqa: BLE001 - styling must never stop the app starting
        return ""


def _stroke(qp, colour: str, width: float, points) -> None:
    from PySide6.QtCore import QPointF, Qt
    from PySide6.QtGui import QColor, QPainterPath, QPen

    qp.setPen(QPen(QColor(colour), width, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
    path = QPainterPath(QPointF(*points[0]))
    for pt in points[1:]:
        path.lineTo(*pt)
    qp.drawPath(path)


def _tick_image() -> str:
    """A white tick for checked boxes (checked boxes differ from empty ones by shape, not colour alone)."""
    return _drawn_png("tick-white-v1.png", lambda qp: _stroke(qp, "#FFFFFF", 6.5, [(11, 25), (20, 34), (37, 14)]))


def _chevron(direction: str, colour: str) -> str:
    """A chevron for combo boxes and spin boxes, in the theme's muted text colour."""
    pts = [(12, 19), (24, 31), (36, 19)] if direction == "down" else [(12, 29), (24, 17), (36, 29)]
    return _drawn_png(f"chevron-{direction}-{colour.lstrip('#').lower()}-v1.png",
                      lambda qp: _stroke(qp, colour, 5.5, pts))


def _arrow_rules(c: dict) -> str:
    """Rounded combo boxes with a clean chevron (text stops before it), and spin boxes with visible up/down
    arrows. Skipped if the icons cannot be drawn, so Qt's native arrows stay rather than vanish."""
    down, up = _chevron("down", c["muted"]), _chevron("up", c["muted"])
    if not (down and up):
        return ""
    return f"""
QComboBox {{ padding: 5px 24px 5px 8px; }}
QComboBox:focus {{ padding: 4px 23px 4px 7px; }}
QComboBox::drop-down {{ subcontrol-origin: padding; subcontrol-position: center right; width: 22px;
                        border: none; background: transparent; }}
QComboBox::down-arrow {{ image: url("{down}"); width: 10px; height: 10px; }}
QComboBox::down-arrow:on {{ image: url("{up}"); }}
QComboBox::down-arrow:disabled {{ image: none; }}
QSpinBox, QDoubleSpinBox {{ padding-right: 28px; }}
QSpinBox:focus, QDoubleSpinBox:focus {{ padding-right: 27px; }}
QSpinBox::up-button, QDoubleSpinBox::up-button {{ subcontrol-origin: border; subcontrol-position: top right;
    width: 24px; border: none; border-left: 1px solid {c['border']}; background: transparent; border-top-right-radius: 8px; }}
QSpinBox::down-button, QDoubleSpinBox::down-button {{ subcontrol-origin: border; subcontrol-position: bottom right;
    width: 24px; border: none; border-left: 1px solid {c['border']}; background: transparent; border-bottom-right-radius: 8px; }}
QSpinBox::up-button:hover, QDoubleSpinBox::up-button:hover, QSpinBox::down-button:hover,
QDoubleSpinBox::down-button:hover {{ background: {c['border']}; }}
QSpinBox::up-arrow, QDoubleSpinBox::up-arrow {{ image: url("{up}"); width: 10px; height: 10px; }}
QSpinBox::down-arrow, QDoubleSpinBox::down-arrow {{ image: url("{down}"); width: 10px; height: 10px; }}
"""


def stylesheet(name: str, font_pt: int = 11) -> str:
    c = palette(name)
    tick_png = _tick_image()
    tick = f'image: url("{tick_png}");' if tick_png else ""
    small = max(8, font_pt - 2)
    tiny = max(9, font_pt - 1)
    return f"""
* {{ font-family: "Segoe UI Variable", "Segoe UI", "Inter", sans-serif; font-size: {font_pt}pt; }}
QMainWindow, QDialog, QWidget#root {{ background: {c['bg']}; color: {c['text']}; }}
QWidget {{ color: {c['text']}; }}
QFrame#card, QFrame#header {{ background: {c['panel']}; border: 1px solid {c['border']}; border-radius: 14px; }}
QFrame#header {{ border-radius: 0; border-width: 0 0 1px 0; }}
QFrame#toolbar {{ background: {c['panel']}; border: 1px solid {c['border']}; border-radius: 12px; }}
QLabel#title {{ font-size: {font_pt + 5}pt; font-weight: 700; }}
QLabel#section {{ color: {c['muted']}; font-size: {small}pt; font-weight: 700; letter-spacing: 1px; }}
QLabel#filler {{ color: {c['muted']}; font-style: italic; font-size: {font_pt + 2}pt; }}
QLabel#say {{ color: {c['say']}; font-size: {font_pt + 7}pt; font-weight: 700; }}
QLabel#more {{ font-size: {font_pt + 3}pt; }}
QLabel#their {{ color: {c['caller']}; font-size: {font_pt + 3}pt; }}
QLabel#warnbox {{ background: rgba(245,158,11,0.15); border: 1px solid {c['warn']}; border-radius: 8px;
                 padding: 6px 10px; color: {c['warn']}; }}
QLabel#chip {{ background: {c['chip']}; border-radius: 10px; padding: 5px 10px; }}
QLabel#badge {{ background: {c['panel2']}; border: 1px solid {c['border']}; border-radius: 9px;
               padding: 2px 8px; color: {c['muted']}; font-size: {tiny}pt; }}
QPushButton {{ background: {c['panel2']}; border: 1px solid {c['border']}; border-radius: 9px;
              padding: 7px 14px; }}
QPushButton:hover {{ border-color: {c['accent']}; }}
QPushButton:pressed {{ background: {c['border']}; }}
QPushButton:disabled {{ color: {c['muted']}; }}
QPushButton#primary {{ background: {c['primary']}; border: none; color: white; font-weight: 700; }}
QPushButton#primary:hover {{ background: {c['primary_hover']}; }}
QPushButton#danger {{ background: {c['danger_bg']}; border: none; color: white; font-weight: 700;
                      font-size: {font_pt + 2}pt; padding: 10px 20px; }}
QPushButton#danger:hover {{ background: {c['danger_hover']}; }}
QPushButton#start {{ background: qlineargradient(x1:0,y1:0,x2:1,y2:1, stop:0 #15803D, stop:1 #166534);
                     border: none; color: white; font-weight: 800; padding: 10px 20px; font-size: {font_pt + 2}pt; }}
QPushButton#start:hover {{ background: #15803D; }}
QPushButton#endcall {{ background: transparent; color: {c['bad_text']}; border: 1px solid {c['bad']}; font-weight: 700;
                       font-size: {font_pt + 2}pt; padding: 9px 19px; }}
QPushButton#endcall:hover {{ background: {c['panel2']}; }}
QPushButton#primary:disabled {{ background: {c['panel2']}; color: {c['muted']}; border: 1px solid {c['border']};
                                font-weight: 600; padding: 6px 13px; }}
QPushButton#danger:disabled, QPushButton#start:disabled, QPushButton#endcall:disabled {{
    background: {c['panel2']}; color: {c['muted']}; border: 1px solid {c['border']}; font-weight: 600; padding: 9px 19px; }}
QPushButton#ghost {{ background: transparent; border: 1px solid {c['border']}; }}
QPushButton#iconbtn {{ background: transparent; border: none; min-width: 24px; min-height: 24px; padding: 4px;
                       font-size: {font_pt + 3}pt; }}
QPushButton#iconbtn:hover {{ background: {c['panel2']}; border-radius: 9px; }}
QFrame#hero {{ background: qlineargradient(x1:0,y1:0,x2:0,y2:1, stop:0 {c['panel']}, stop:1 {c['panel2']});
               border: 1px solid {c['border']}; border-left: 5px solid {c['accent']}; border-radius: 16px; }}
QFrame#banner {{ background: rgba(245,158,11,0.14); border: 1px solid {c['warn']}; border-radius: 12px; }}
QFrame#banner_ok {{ background: rgba(34,197,94,0.12); border: 1px solid {c['good']}; border-radius: 12px; }}
QFrame#banner_next {{ background: rgba(20,102,210,0.12); border: 1px solid {c['accent']}; border-radius: 12px; }}
QLabel#hint {{ color: {c['muted']}; font-size: {tiny}pt; }}
QLabel#pill_live {{ background: rgba(239,68,68,0.15); color: {c['bad_text']}; border: 1px solid {c['bad']};
                    border-radius: 10px; padding: 3px 8px; font-weight: 700; }}
QLabel#pill_idle {{ background: {c['panel2']}; color: {c['muted']}; border: 1px solid {c['border']};
                    border-radius: 10px; padding: 3px 8px; }}
QLabel#pill_amber {{ background: rgba(245,158,11,0.15); color: {c['warn']}; border: 1px solid {c['warn']};
                     border-radius: 10px; padding: 3px 8px; font-weight: 700; }}
QListWidget::item {{ padding: 7px 8px; border-radius: 6px; }}
QListWidget::item:hover {{ background: {c['border']}; }}
QListWidget::item:selected {{ background: {c['primary']}; color: white; border-radius: 6px; }}
QListWidget#recent {{ border: 2px solid transparent; background: transparent; }}
QListWidget#recent:focus {{ border-color: {c['accent']}; }}
QListWidget#recent::item {{ padding: 6px 4px; color: {c['muted']}; }}
QListWidget#recent::item:selected {{ color: white; }}
QComboBox {{ padding: 6px 10px; }}
QLineEdit, QTextEdit, QPlainTextEdit, QComboBox, QSpinBox, QDoubleSpinBox, QListWidget, QTableWidget,
QTextBrowser {{ background: {c['panel2']}; border: 1px solid {c['field_border']}; border-radius: 8px; padding: 5px;
               selection-background-color: {c['primary']}; selection-color: white; }}
QTextBrowser {{ border-color: {c['border']}; }}
QPushButton:focus, QPushButton#ghost:focus {{ border: 2px solid {c['accent']}; padding: 6px 13px; }}
QPushButton#primary:focus {{ border: 2px solid {c['focus_on_fill']}; padding: 5px 12px; }}
QPushButton#danger:focus, QPushButton#start:focus {{ border: 2px solid {c['focus_on_fill']}; padding: 8px 18px; }}
QPushButton#endcall:focus {{ border: 2px solid {c['accent']}; padding: 8px 18px; }}
QPushButton#danger[bar="true"] {{ font-size: {font_pt}pt; padding: 7px 14px; }}
QPushButton#danger[bar="true"]:focus {{ padding: 5px 12px; }}
QPushButton#iconbtn:focus {{ border: 2px solid {c['accent']}; border-radius: 9px; padding: 2px; }}
QPushButton#ghost:checked {{ background: {c['chip']}; border-color: {c['accent']}; color: {c['text']}; }}
QPushButton#ghost:checked:focus {{ border: 2px solid {c['focus_on_fill']}; padding: 6px 13px; }}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus, QComboBox:focus, QListWidget:focus, QTableWidget:focus,
QTextBrowser:focus, QSpinBox:focus, QDoubleSpinBox:focus {{ border: 2px solid {c['accent']}; padding: 4px; }}
QCheckBox {{ border: 2px solid transparent; border-radius: 6px; padding: 2px 4px; spacing: 8px; }}
QCheckBox:focus {{ border-color: {c['accent']}; }}
QComboBox QAbstractItemView {{ background: {c['panel']}; selection-background-color: {c['primary']};
                              selection-color: white; }}
QHeaderView::section {{ background: {c['panel']}; color: {c['muted']}; border: none; padding: 6px; }}
QTableView {{ gridline-color: {c['border']}; }}
QTableCornerButton::section, QHeaderView {{ background: {c['panel']}; border: none; }}
QTableView::item {{ padding: 2px 4px; }}
QTabWidget::pane {{ border: 1px solid {c['border']}; border-radius: 10px; background: {c['panel']}; top: -1px; }}
QTabBar::tab {{ background: transparent; color: {c['muted']}; padding: 8px 14px; border: none; }}
QTabBar::tab:focus {{ border: 2px solid {c['accent']}; border-radius: 6px; padding: 6px 12px; }}
QTabBar::tab:selected {{ color: {c['text']}; border-bottom: 2px solid {c['accent']}; }}
QTabBar QToolButton {{ background: {c['panel2']}; color: {c['text']}; border: 1px solid {c['border']}; border-radius: 6px; }}
QTabBar QToolButton:focus {{ border-color: {c['accent']}; }}
QScrollArea {{ background: transparent; border: none; }}
QScrollArea#sayscroll {{ border: 2px solid transparent; border-radius: 8px; }}
QScrollArea#sayscroll:focus {{ border-color: {c['accent']}; }}
QListWidget#nav {{ background: transparent; border: 2px solid transparent; border-radius: 10px; padding: 2px; }}
QListWidget#nav:focus {{ border-color: {c['accent']}; padding: 2px; }}
QListWidget#nav::item {{ padding: 8px 12px; margin: 1px 0; color: {c['muted']}; }}
QListWidget#nav::item:hover {{ background: {c['panel2']}; color: {c['text']}; }}
QListWidget#nav::item:selected {{ background: {c['chip']}; color: {c['text']}; font-weight: 700; }}
QWidget#formpanel {{ background: {c['panel']}; }}
QSplitter::handle {{ background: {c['bg']}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; }}
QScrollBar::handle:vertical {{ background: {c['field_border']}; border-radius: 5px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: {c['muted']}; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
QCheckBox::indicator, QAbstractItemView::indicator {{ width: 14px; height: 14px; border: 2px solid {c['field_border']};
    border-radius: 4px; background: {c['panel2']}; }}
QCheckBox::indicator:hover, QAbstractItemView::indicator:hover {{ border-color: {c['accent']}; }}
QCheckBox::indicator:checked, QAbstractItemView::indicator:checked {{ background: {c['accent']}; border-color: {c['accent']};
    {tick} }}
QAbstractItemView::indicator:checked:selected {{ border-color: white; }}
QCheckBox::indicator:disabled, QAbstractItemView::indicator:disabled {{ border-color: {c['border']}; background: {c['panel']}; }}
QCheckBox::indicator:checked:disabled, QAbstractItemView::indicator:checked:disabled {{ background: {c['muted']};
    border-color: {c['muted']}; }}
QCheckBox:disabled {{ color: {c['muted']}; }}
QStatusBar {{ background: {c['panel']}; color: {c['muted']}; border-top: 1px solid {c['border']}; }}
QToolTip {{ background: {c['panel']}; color: {c['text']}; border: 1px solid {c['border']}; }}
QProgressBar {{ background: {c['panel2']}; border: none; border-radius: 4px; height: 8px; }}
QProgressBar::chunk {{ background: {c['good']}; border-radius: 4px; }}
QLineEdit, QTextEdit, QPlainTextEdit {{ placeholder-text-color: {c['muted']}; }}
QListWidget {{ outline: 0; }}
""" + _arrow_rules(c)
