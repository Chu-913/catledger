"""生成 App 启动图标（各密度），输出到 android/res/mipmap-*/ic_launcher.png"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'android', 'res')
SIZES = {
    'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192,
}

S = 1024
C1 = (76, 139, 255)    # 上：亮蓝
C2 = (41, 92, 214)     # 下：深蓝


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_icon():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # 竖向渐变底
    grad = Image.new('RGB', (1, S))
    px = grad.load()
    for y in range(S):
        t = y / (S - 1)
        px[0, y] = (
            round(C1[0] + (C2[0] - C1[0]) * t),
            round(C1[1] + (C2[1] - C1[1]) * t),
            round(C1[2] + (C2[2] - C1[2]) * t),
        )
    grad = grad.resize((S, S), Image.BICUBIC)
    img.paste(grad, (0, 0), rounded_mask(S, round(S * 0.225)))

    # 2x2 分类格
    d = ImageDraw.Draw(img)
    box = S * 0.52
    gap = S * 0.075
    side = (box - gap) / 2
    x0 = (S - box) / 2
    y0 = (S - box) / 2
    radius = side * 0.30
    alphas = [242, 176, 176, 120]
    i = 0
    for row in range(2):
        for col in range(2):
            x = x0 + col * (side + gap)
            y = y0 + row * (side + gap)
            d.rounded_rectangle(
                [x, y, x + side, y + side],
                radius=radius,
                fill=(255, 255, 255, alphas[i]),
            )
            i += 1
    return img


def main():
    icon = make_icon()
    for dens, px in SIZES.items():
        folder = os.path.join(OUT, 'mipmap-' + dens)
        os.makedirs(folder, exist_ok=True)
        icon.resize((px, px), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher.png'))
        print('wrote', os.path.join(folder, 'ic_launcher.png'), px)

    preview_dir = os.path.join(os.path.dirname(__file__), '..', 'docs')
    os.makedirs(preview_dir, exist_ok=True)
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(preview_dir, 'icon-512.png'))
    print('wrote docs/icon-512.png')


if __name__ == '__main__':
    main()