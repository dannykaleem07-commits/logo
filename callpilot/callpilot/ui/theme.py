"""Premium dark/light styling (brand: navy #072647, blue #1466D2)."""

from __future__ import annotations

DARK = {
    "bg": "#0A1120", "panel": "#101A2E", "panel2": "#16233D", "border": "#22324F",
    "text": "#E8EEF8", "muted": "#8EA0BD", "accent": "#1F7BFF", "accent2": "#1466D2",
    "good": "#22C55E", "warn": "#F59E0B", "bad": "#EF4444", "agent": "#7DD3FC", "caller": "#FBBF24",
    "say": "#FFFFFF", "chip": "#1B2B4A", "bubble_caller": "#1A2742", "bubble_agent": "#12325A",
}
LIGHT = {
    "bg": "#F4F7FB", "panel": "#FFFFFF", "panel2": "#EEF3FA", "border": "#D5DEEB",
    "text": "#0B1730", "muted": "#5B6B85", "accent": "#1466D2", "accent2": "#072647",
    "good": "#15803D", "warn": "#B45309", "bad": "#B91C1C", "agent": "#0369A1", "caller": "#B45309",
    "say": "#072647", "chip": "#E3ECF9", "bubble_caller": "#EEF3FA", "bubble_agent": "#DCEBFF",
}


def palette(name: str) -> dict:
    return LIGHT if name == "light" else DARK


def stylesheet(name: str, font_pt: int = 11) -> str:
    c = palette(name)
    return f"""
* {{ font-family: "Segoe UI Variable", "Segoe UI", "Inter", sans-serif; font-size: {font_pt}pt; }}
QMainWindow, QDialog, QWidget#root {{ background: {c['bg']}; color: {c['text']}; }}
QWidget {{ color: {c['text']}; }}
QFrame#card, QFrame#header {{ background: {c['panel']}; border: 1px solid {c['border']}; border-radius: 14px; }}
QFrame#header {{ border-radius: 0; border-width: 0 0 1px 0; }}
QLabel#title {{ font-size: {font_pt + 5}pt; font-weight: 700; }}
QLabel#section {{ color: {c['muted']}; font-size: {font_pt - 2}pt; font-weight: 700; letter-spacing: 1px; }}
QLabel#filler {{ color: {c['muted']}; font-style: italic; font-size: {font_pt + 2}pt; }}
QLabel#say {{ color: {c['say']}; font-size: {font_pt + 7}pt; font-weight: 700; }}
QLabel#more {{ font-size: {font_pt + 3}pt; }}
QLabel#their {{ color: {c['caller']}; font-size: {font_pt + 3}pt; }}
QLabel#warnbox {{ background: rgba(245,158,11,0.15); border: 1px solid {c['warn']}; border-radius: 8px;
                 padding: 6px 10px; color: {c['warn']}; }}
QLabel#chip {{ background: {c['chip']}; border-radius: 10px; padding: 5px 10px; }}
QLabel#badge {{ background: {c['panel2']}; border: 1px solid {c['border']}; border-radius: 9px;
               padding: 2px 8px; color: {c['muted']}; font-size: {font_pt - 1}pt; }}
QPushButton {{ background: {c['panel2']}; border: 1px solid {c['border']}; border-radius: 9px;
              padding: 7px 14px; }}
QPushButton:hover {{ border-color: {c['accent']}; }}
QPushButton:pressed {{ background: {c['border']}; }}
QPushButton:disabled {{ color: {c['muted']}; }}
QPushButton#primary {{ background: {c['accent']}; border: none; color: white; font-weight: 700; }}
QPushButton#danger {{ background: {c['bad']}; border: none; color: white; font-weight: 700; }}
QPushButton#start {{ background: qlineargradient(x1:0,y1:0,x2:1,y2:1, stop:0 #22C55E, stop:1 #15803D);
                     border: none; color: white; font-weight: 800; padding: 10px 26px; font-size: {font_pt + 2}pt; }}
QPushButton#start:hover {{ background: #22C55E; }}
QPushButton#danger {{ font-size: {font_pt + 2}pt; padding: 10px 26px; }}
QPushButton#ghost {{ background: transparent; border: 1px solid {c['border']}; }}
QPushButton#iconbtn {{ background: transparent; border: none; padding: 4px 8px; font-size: {font_pt + 3}pt; }}
QPushButton#iconbtn:hover {{ background: {c['panel2']}; border-radius: 9px; }}
QFrame#hero {{ background: qlineargradient(x1:0,y1:0,x2:0,y2:1, stop:0 {c['panel']}, stop:1 {c['panel2']});
               border: 1px solid {c['border']}; border-left: 5px solid {c['accent']}; border-radius: 16px; }}
QFrame#banner {{ background: rgba(245,158,11,0.14); border: 1px solid {c['warn']}; border-radius: 12px; }}
QFrame#banner_ok {{ background: rgba(34,197,94,0.12); border: 1px solid {c['good']}; border-radius: 12px; }}
QLabel#hint {{ color: {c['muted']}; font-size: {font_pt - 1}pt; }}
QLabel#pill_live {{ background: rgba(239,68,68,0.15); color: {c['bad']}; border: 1px solid {c['bad']};
                    border-radius: 10px; padding: 3px 10px; font-weight: 700; }}
QLabel#pill_idle {{ background: {c['panel2']}; color: {c['muted']}; border: 1px solid {c['border']};
                    border-radius: 10px; padding: 3px 10px; }}
QLabel#pill_amber {{ background: rgba(245,158,11,0.15); color: {c['warn']}; border: 1px solid {c['warn']};
                     border-radius: 10px; padding: 3px 10px; font-weight: 700; }}
QListWidget#recent {{ border: none; background: transparent; }}
QListWidget#recent::item {{ padding: 6px 4px; color: {c['muted']}; }}
QComboBox {{ padding: 6px 10px; }}
QLineEdit, QTextEdit, QPlainTextEdit, QComboBox, QSpinBox, QDoubleSpinBox, QListWidget, QTableWidget,
QTextBrowser {{ background: {c['panel2']}; border: 1px solid {c['border']}; border-radius: 8px; padding: 5px;
               selection-background-color: {c['accent']}; }}
QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus, QComboBox:focus {{ border-color: {c['accent']}; }}
QComboBox QAbstractItemView {{ background: {c['panel']}; selection-background-color: {c['accent']}; }}
QHeaderView::section {{ background: {c['panel']}; color: {c['muted']}; border: none; padding: 6px; }}
QTabWidget::pane {{ border: 1px solid {c['border']}; border-radius: 10px; background: {c['panel']}; top: -1px; }}
QTabBar::tab {{ background: transparent; color: {c['muted']}; padding: 8px 14px; border: none; }}
QTabBar::tab:selected {{ color: {c['text']}; border-bottom: 2px solid {c['accent']}; }}
QScrollArea {{ background: transparent; border: none; }}
QWidget#formpanel {{ background: {c['panel']}; }}
QSplitter::handle {{ background: {c['bg']}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; }}
QScrollBar::handle:vertical {{ background: {c['border']}; border-radius: 5px; min-height: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
QCheckBox::indicator {{ width: 18px; height: 18px; }}
QStatusBar {{ background: {c['panel']}; color: {c['muted']}; border-top: 1px solid {c['border']}; }}
QToolTip {{ background: {c['panel']}; color: {c['text']}; border: 1px solid {c['border']}; }}
QProgressBar {{ background: {c['panel2']}; border: none; border-radius: 4px; height: 8px; }}
QProgressBar::chunk {{ background: {c['good']}; border-radius: 4px; }}
"""
