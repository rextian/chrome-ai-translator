#!/usr/bin/env python3
"""生成扩展图标：蓝紫渐变圆角方块 + 双气泡（翻译寓意），纯标准库实现。"""
import struct
import zlib
import os

SS = 4  # 超采样倍数


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))


def in_rounded_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def render(size):
    s = size * SS
    px = bytearray(s * s * 4)

    top = (79, 124, 255)    # #4F7CFF
    bottom = (122, 79, 255) # #7A4FFF

    m = s * 0.02
    r = s * 0.24

    # 气泡2（右下大，白色）：圆角矩形 + 小尾巴
    b2 = (s * 0.20, s * 0.34, s * 0.80, s * 0.78)  # x0,y0,x1,y1
    b2r = s * 0.10
    # 气泡1（左上小，半透明白）
    b1 = (s * 0.16, s * 0.15, s * 0.58, s * 0.44)
    b1r = s * 0.09

    # 气泡内文字线条（蓝紫色，画在气泡2上）
    line_color = top
    l1 = (s * 0.29, s * 0.47, s * 0.71, s * 0.53)
    l2 = (s * 0.29, s * 0.58, s * 0.58, s * 0.64)

    for y in range(s):
        t = y / (s - 1)
        bg = lerp_color(top, bottom, t)
        row = y * s * 4
        for x in range(s):
            i = row + x * 4
            if not in_rounded_rect(x, y, m, m, s - 1 - m, s - 1 - m, r):
                px[i:i+4] = b'\x00\x00\x00\x00'
                continue
            cr, cg, cb, ca = bg[0], bg[1], bg[2], 255

            # 气泡1（半透明白 0.55）+ 尾巴
            in_b1 = in_rounded_rect(x, y, *b1, b1r) or (
                b1[0] + s*0.06 < x < b1[0] + s*0.16 and
                b1[3] - s*0.02 < y < b1[3] + s*0.10 and
                x - (b1[0] + s*0.06) < (y - (b1[3] - s*0.02)) * 1.2
            )
            if in_b1:
                a = 0.55
                cr = int(cr * (1 - a) + 255 * a)
                cg = int(cg * (1 - a) + 255 * a)
                cb = int(cb * (1 - a) + 255 * a)

            # 气泡2（白）+ 尾巴
            in_b2_tail = (
                b2[2] - s*0.17 < x < b2[2] - s*0.06 and
                b2[3] - s*0.02 < y < b2[3] + s*0.10 and
                (b2[2] - s*0.06) - x < (y - (b2[3] - s*0.02)) * 1.2
            )
            if in_rounded_rect(x, y, *b2, b2r) or in_b2_tail:
                cr, cg, cb = 255, 255, 255

            # 文字线
            if in_rounded_rect(x, y, *l1, (l1[3]-l1[1]) / 2) or in_rounded_rect(x, y, *l2, (l2[3]-l2[1]) / 2):
                cr, cg, cb = line_color

            px[i:i+4] = bytes((cr, cg, cb, ca))

    # 下采样 box filter
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                for dx in range(SS):
                    si = ((y * SS + dy) * s + (x * SS + dx)) * 4
                    for c in range(4):
                        acc[c] += px[si + c]
            oi = (y * size + x) * 4
            n = SS * SS
            out[oi:oi+4] = bytes(acc[c] // n for c in range(4))
    return out


def write_png(path, size, rgba):
    def chunk(typ, data):
        c = struct.pack('>I', len(data)) + typ + data
        return c + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF)

    raw = b''.join(
        b'\x00' + bytes(rgba[y * size * 4:(y + 1) * size * 4])
        for y in range(size)
    )
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        write_png(os.path.join(out_dir, f'icon-{size}.png'), size, render(size))
        print(f'icon-{size}.png done')
