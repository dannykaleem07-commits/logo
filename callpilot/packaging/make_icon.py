"""Render assets/icon.png and assets/icon.ico (brand navy/blue, headset + waveform)."""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "assets"
S = 1024


def render() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=220, fill=(7, 38, 71, 255))
    d.rounded_rectangle((40, 40, S - 40, S - 40), radius=220, outline=(31, 123, 255, 255), width=28)
    # headset band
    d.arc((210, 190, 814, 794), start=180, end=360, fill=(255, 255, 255, 255), width=64)
    # ear cups
    d.rounded_rectangle((170, 470, 330, 720), radius=60, fill=(31, 123, 255, 255))
    d.rounded_rectangle((694, 470, 854, 720), radius=60, fill=(31, 123, 255, 255))
    # waveform
    bars = [90, 170, 260, 170, 90]
    x0 = 382
    for i, h in enumerate(bars):
        x = x0 + i * 58
        d.rounded_rectangle((x, 595 - h // 2, x + 36, 595 + h // 2), radius=18, fill=(255, 255, 255, 255))
    return img


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    im = render()
    im.resize((256, 256), Image.LANCZOS).save(OUT / "icon.png")
    im.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("icons written to", OUT)
