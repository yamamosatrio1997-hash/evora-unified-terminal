"""
QUANTBOT HQ - kantor dua lantai bergaya Minecraft untuk Blender 4.2+ / 5.x.

Lantai 1 : Trading Floor (9 Trade Executor, curved monitor + terminal Bloomberg,
           video wall melengkung di tengah), Meeting Room (LCD besar sebagai papan
           tulis presentasi), Pantry (dispenser, microwave, keran air, kulkas,
           lemari pantry), tangga ke lantai 2.
Lantai 2 : 9 ruang Lead (ATLAS, SAGE, CIPHER, VORTEX, CHRONOS, ALPHA, SENTINEL,
           KILLJOY, ODIN), ruang pribadi Owner (lebih besar, set DJ, meja + kursi +
           curved monitor), Game Room di sebelahnya, lobby dengan hologram BTC.
Eksterior: taman rumput, plaza, jalan raya, trotoar, parkiran + mobil, pohon,
           palem, lampu jalan, monumen logo, gedung tetangga.
Semua lantai ruangan memakai tekstur kayu pixel (gaya papan Minecraft).

Kamera per ruangan + panel "QUANTBOT" di sidebar viewport (lihat
quantbot_viewer_panel.py) untuk pindah ruangan, sembunyikan lantai, dan zoom
langsung sambil animasi diputar.

Pemakaian:
  blender --background --python build_quantbot_hq.py -- \
     [--save quantbot_hq.blend] [--glb quantbot_hq.glb] \
     [--render CAM_Building:hq_building.png:300] [--samples 32] [--res 1600x1000]
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else bpy.path.abspath("//")
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from build_office_miniature import box, collection, cyl, empty, hex_rgba, mat, sphere, text  # noqa: E402
from build_quantbot_office import (  # noqa: E402
    MSG_F, MSG_GAP, SEAT_H, STRIDE_F, CRYPTO_LOGOS, CRYPTO_NAMES, Plan, apply_pose, attach_bubble,
    bake, build_chair, build_plant, build_rig, clear_all, coin_hologram, crypto_logo, iso_camera,
    lights_and_world, make_bubble, make_library_actions, painting, palette, polyline, pose_stand,
    pose_talk, pose_type, wrap,
)

FH = 3.6                         # tinggi lantai ke lantai
X0, X1, Y0, Y1 = -11.0, 11.0, -7.0, 7.0
WALL_T = 0.25

# Lantai 1
TRADING = (-11.0, -7.0, 2.5, 7.0)
CORRIDOR_X = (2.5, 4.0)
MEETING = (4.0, -0.5, 11.0, 7.0)
PANTRY = (4.0, -7.0, 11.0, -0.5)
EXEC_COLS = (-8.0, -4.25, -0.5)
EXEC_ROWS = (0.4, 2.9, 5.4)
VIDEO_WALL_Y = -2.0
MEET_DOOR_Y = 0.9
WALK_X = 1.9
TABLE_C, TABLE_L, TABLE_W = Vector((7.5, 2.9)), 4.4, 1.4
SIDE_YS = (1.25, 2.4, 3.55, 4.7)
WEST_SEAT_X, EAST_SEAT_X = 6.45, 8.55
HEAD_SEAT = Vector((7.5, 5.8))
STAIRS = (2.6, -6.4, 3.9, -1.4)          # x0, y0, x1, y1 (naik ke +Y)
STAIR_HOLE = (2.5, -6.7, 4.0, -1.3)
ENTRANCE = (-0.9, 2.0)                   # rentang x titik tengah panel kaca yang jadi pintu masuk

# Lantai 2
LEAD_COLS = ((-11.0, -7.17), (-7.17, -3.33), (-3.33, 0.5))
LEAD_ROWS = ((2.33, 7.0), (-2.33, 2.33), (-7.0, -2.33))
HALL = (0.5, -7.0, 4.0, 7.0)
OWNER = (4.0, -1.0, 11.0, 7.0)
GAME = (4.0, -7.0, 11.0, -1.0)

TOGGLES = ("Exterior", "Floor_1", "Floor_2", "Roof", "Facade_1", "Facade_2")

WOODS = {
    "oak": ("#B8945F", "#C9A46C", "#8F6E43"),
    "walnut": ("#6B4A2E", "#7A5636", "#4E3520"),
    "birch": ("#D8C7A0", "#E4D5B0", "#B5A27A"),
    "teak": ("#A0643C", "#B07448", "#7A4A2A"),
    "ash": ("#C2A27E", "#D1B28C", "#9B7F5E"),
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="build_quantbot_hq")
    p.add_argument("--data", default=os.path.join(HERE, "quantbot_hq.json"))
    p.add_argument("--save")
    p.add_argument("--glb", help="ekspor GLB untuk web viewer")
    p.add_argument("--schedule", help="tulis jadwal bicara + view kamera (JSON) untuk web viewer")
    p.add_argument("--render", action="append", default=[], help="KAMERA:file.png:frame")
    p.add_argument("--render-lineup", help="render 19 karakter berjajar ke file PNG")
    p.add_argument("--samples", type=int, default=32)
    p.add_argument("--res", default="1600x1000")
    return p.parse_args(argv)


# --------------------------------------------------------- tekstur pixel

def _hash(*v):
    h = 2166136261
    for x in v:
        h = ((h ^ (int(x) & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    return h


def gen_image(name, w, h, fn):
    """Gambar pixel; fn(x, y) -> hex. y=0 adalah baris atas."""
    img = bpy.data.images.new(name, w, h, alpha=False)
    cache, px = {}, []
    for y in range(h - 1, -1, -1):
        for x in range(w):
            c = fn(x, y)
            if c not in cache:
                cache[c] = hex_rgba(c)
            px.extend(cache[c])
    img.pixels = px
    img.pack()
    return img


def image_mat(name, img, rough=0.7, emit=0.0):
    m = bpy.data.materials.new(name)
    if bpy.app.version < (5, 0):
        m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    if emit:
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = tuple(img.pixels[0:4]) if len(img.pixels) else (0.5, 0.5, 0.5, 1)
    return m


def planks_image(kind):
    base, light, dark = WOODS[kind]

    def fn(x, y):
        row = y // 4
        if y % 4 == 3:
            return dark
        if x == (row * 5 + 3) % 16:
            return dark
        r = _hash(x, y, row, len(kind)) % 10
        return light if r < 3 else (dark if r == 9 else base)
    return gen_image(f"TEX_planks_{kind}", 16, 16, fn)


def noise_image(name, colors, size=16, weights=None, seed=1):
    weights = weights or [1] * len(colors)
    total = sum(weights)

    def fn(x, y):
        r = _hash(x, y, seed) % total
        for c, wgt in zip(colors, weights):
            if r < wgt:
                return c
            r -= wgt
        return colors[-1]
    return gen_image(name, size, size, fn)


def chart_image(name, seed, w=64, h=32):
    price, cand = h * 0.5, []
    s = seed
    for i in range(w // 3):
        s = (s * 1103515245 + 12345) % 2 ** 31
        move = ((s >> 8) % 100 / 100 - 0.45) * 5
        o, c = price, max(4, min(h - 5, price + move))
        hi, lo = max(o, c) + 1 + (s >> 3) % 2, min(o, c) - 1 - (s >> 5) % 2
        cand.append((o, c, hi, lo))
        price = c

    def fn(x, y):
        yy = h - 1 - y
        i, k = divmod(x, 3)
        if i < len(cand) and k < 2:
            o, c, hi, lo = cand[i]
            col = "#26DE81" if c >= o else "#FF4D5E"
            if min(o, c) <= yy <= max(o, c):
                return col
            if k == 0 and lo <= yy <= hi:
                return col
        if i < len(cand) and abs(yy - sum(cd[1] for cd in cand[max(0, i - 4):i + 1]) / len(cand[max(0, i - 4):i + 1])) < 0.6:
            return "#F7C948"
        if x % 8 == 0 or y % 8 == 0:
            return "#13213A"
        return "#0B1424"
    return gen_image(name, w, h, fn)


def bloomberg_image():
    def fn(x, y):
        if y == 0:
            return "#FF9F1C"
        r = _hash(x, y, 77) % 10
        if y % 3 == 0:
            return "#050505"
        if x > 22:
            return "#26DE81" if r < 4 else ("#FF4D5E" if r < 6 else "#050505")
        return "#FF9F1C" if r < 5 else ("#F0F0F0" if r < 6 else "#050505")
    return gen_image("TEX_bloomberg", 32, 20, fn)


def slide_image():
    chart = [(i, 6 + int(5 * math.sin(i / 3.0) + i / 3)) for i in range(0, 30)]

    def fn(x, y):
        if y < 6:
            return "#1FA8C9" if x > 1 else "#F7C948"
        if 8 <= y < 34 and 2 <= x < 36:
            i = (x - 2)
            top = 33 - chart[min(i, len(chart) - 1)][1]
            if y >= top:
                return "#26DE81" if i % 2 == 0 else "#1E8F5A"
            return "#132238"
        if 40 <= x < 62 and 10 <= y < 33:
            if x < 49 and y > 14:
                return "#26DE81"
            if 53 <= x < 62 and y > 21:
                return "#FF4D5E"
            return "#0F1B2D"
        return "#0F1B2D"
    return gen_image("TEX_slide", 64, 36, fn)


def game_image(seed):
    def fn(x, y):
        if y > 13:
            return "#2ECC71"
        if (x + seed) % 7 in (1, 2) and 3 <= y <= 4:
            return "#F1C40F"
        if 7 <= x <= 9 and 11 <= y <= 13:
            return "#E74C3C"
        if _hash(x, y, seed) % 23 == 0:
            return "#FFFFFF"
        return "#1B1464" if seed % 2 else "#0A3D62"
    return gen_image(f"TEX_game{seed}", 16, 16, fn)


def led_image():
    cols = ["#FF006E", "#8338EC", "#3A86FF", "#06D6A0", "#FFBE0B", "#FB5607"]

    def fn(x, y):
        return cols[(x // 2 + y // 2 + _hash(x // 2, y // 2) % 2) % len(cols)]
    return gen_image("TEX_led", 16, 8, fn)


# ---------------------------------------------------------- geometri dasar

def uv_box(name, size, loc, material, col, parent=None, tile=1.0, rot=(0, 0, 0)):
    """Kotak (loc = tengah bawah) dengan UV proyeksi kotak dalam satuan meter / tile."""
    sx, sy, sz = size
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    uv = bm.loops.layers.uv.new()
    off = Vector((loc[0], loc[1], loc[2] + sz / 2))
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            w = lp.vert.co + off
            u, v = ((w.y, w.z), (w.x, w.z), (w.x, w.y))[ax]
            lp[uv].uv = (u / tile, v / tile)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.location = off
    ob.rotation_euler = rot
    ob.parent = parent
    return ob


def rect_floor(name, rect, z, material, col, thick=0.04):
    x0, y0, x1, y1 = rect
    return uv_box(name, (x1 - x0, y1 - y0, thick), ((x0 + x1) / 2, (y0 + y1) / 2, z - thick), material, col)


def screen_panel(name, w, h, loc, material, col, parent=None):
    """Bidang layar ber-UV 0..1 menghadap -Y lokal; loc = tengah bawah."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    vs = [bm.verts.new((x, 0, z)) for x, z in ((-w / 2, 0), (w / 2, 0), (w / 2, h), (-w / 2, h))]
    face = bm.faces.new(vs)
    for lp, co in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        lp[uv].uv = co
    bm.normal_update()
    if face.normal.y > 0:
        face.normal_flip()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.location = loc
    ob.parent = parent
    return ob


def curved_screen(name, width, height, radius, loc, yaw_deg, screen_mat, back_mat, col, parent=None,
                  segs=18, depth=0.035):
    """Layar melengkung (cekung ke -Y lokal). loc = tengah bawah layar."""
    g = empty(name, loc, yaw_deg, col, parent)
    a = width / (2 * radius)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    front, back = [], []
    for i in range(segs + 1):
        t = -a + 2 * a * i / segs
        x, y = radius * math.sin(t), radius * (math.cos(t) - 1)
        nx, ny = math.sin(t), math.cos(t)
        front.append((bm.verts.new((x, y, 0)), bm.verts.new((x, y, height)), i / segs))
        back.append((bm.verts.new((x + nx * depth, y + ny * depth, -0.01)),
                     bm.verts.new((x + nx * depth, y + ny * depth, height + 0.01))))
    for i in range(segs):
        (b0, t0, u0), (b1, t1, u1) = front[i], front[i + 1]
        f = bm.faces.new((b0, b1, t1, t0))
        f.material_index = 0
        for lp, co in zip(f.loops, ((u0, 0), (u1, 0), (u1, 1), (u0, 1))):
            lp[uv].uv = co
        (bb0, bt0), (bb1, bt1) = back[i], back[i + 1]
        for quad in ((bb1, bb0, bt0, bt1), (b0, bb0, bb1, b1), (t1, bt1, bt0, t0)):
            bm.faces.new(quad).material_index = 1
    for (b, t, _), (bb, bt) in ((front[0], back[0]), (front[-1], back[-1])):
        bm.faces.new((b, t, bt, bb)).material_index = 1
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(screen_mat)
    me.materials.append(back_mat)
    ob = bpy.data.objects.new(f"{name}_panel", me)
    col.objects.link(ob)
    ob.parent = g
    return g


def glass_wall(name, p0, p1, z0, h, P, col, door=None, frame_mat=None):
    """Dinding kaca berbingkai kayu dari p0 ke p1; door = (t0, t1) posisi bukaan (0..1)."""
    frame_mat = frame_mat or mat("#6B4A2E", 0.6)
    p0, p1 = Vector(p0), Vector(p1)
    spans = [(0.0, 1.0)] if door is None else [(0.0, door[0]), (door[1], 1.0)]
    d = p1 - p0
    ang = math.atan2(d.y, d.x)
    for k, (t0, t1) in enumerate(spans):
        if t1 - t0 < 0.01:
            continue
        a, b = p0 + d * t0, p0 + d * t1
        mid, length = (a + b) / 2, (b - a).length
        box(f"{name}_{k}_glass", (length, 0.03, h), (mid.x, mid.y, z0), P["glass"], col, rot=(0, 0, ang), bevel=0)
        for zz in (z0, z0 + h - 0.06):
            box(f"{name}_{k}_rail", (length, 0.07, 0.06), (mid.x, mid.y, zz), frame_mat, col, rot=(0, 0, ang), bevel=0)
        for t in (0.0, 1.0):
            q = a + (b - a) * t
            box(f"{name}_{k}_post", (0.07, 0.07, h), (q.x, q.y, z0), frame_mat, col, bevel=0)


# --------------------------------------------------------------- perabot

def office_chair(name, pos, yaw_deg, color_hex, z, P, col):
    g = build_chair(name, pos, yaw_deg, color_hex, P, col)
    g.location.z = z
    return g


def trader_desk(agent, seat, z, P, M, col, executor=True):
    """Meja trader: curved monitor + terminal Bloomberg (executor). Agen menghadap -Y."""
    name, lk = agent["id"], agent["look"]
    g = empty(f"Desk_{name}", (seat.x, seat.y, z), 0, col)
    g["agent_id"] = name
    dy = -0.62
    box(f"{g.name}_top", (2.0, 0.85, 0.05), (0, dy, 0.71), P["desk"], col, g)
    for sx in (-0.95, 0.95):
        box(f"{g.name}_leg{sx:+.0f}", (0.06, 0.75, 0.71), (sx, dy, 0), P["desk_leg"], col, g)
    box(f"{g.name}_panel", (1.84, 0.03, 0.42), (0, dy - 0.39, 0.28), mat(lk["top"], 0.6), col, g)
    text(f"{g.name}_name", name, (0, dy - 0.42, 0.5), 0.13, mat(label_color_safe(lk), 0.4, emit=1.2), col, g, yaw_deg=0)
    text(f"{g.name}_role", agent["role"].upper(), (0, dy - 0.42, 0.36), 0.06, P["white"], col, g, yaw_deg=0)
    # curved monitor ultrawide, layar menghadap agen (+Y)
    box(f"{g.name}_mon_base", (0.28, 0.2, 0.02), (0, -0.82, 0.76), P["monitor"], col, g)
    box(f"{g.name}_mon_neck", (0.05, 0.04, 0.18), (0, -0.86, 0.78), P["monitor"], col, g)
    curved_screen(f"{g.name}_curve", 0.98, 0.42, 0.9, (0, -0.78, 0.92), 180, M["chart"][hash_name(name) % 3],
                  P["monitor"], col, g)
    if executor:
        # terminal Bloomberg: dua layar kecil + keyboard berwarna khas
        for k, mx in enumerate((0.62, 0.86)):
            m = empty(f"{g.name}_bbg{k}", (mx, -0.74, 0.76), 180 - 25, col, g)
            box(f"{m.name}_stand", (0.12, 0.1, 0.02), (0, 0, 0), P["monitor"], col, m)
            box(f"{m.name}_body", (0.26, 0.03, 0.22), (0, 0, 0.14), P["monitor"], col, m)
            screen_panel(f"{m.name}_scr", 0.23, 0.19, (0, -0.02, 0.155), M["bloomberg"], col, m)
            box(f"{m.name}_neck", (0.03, 0.03, 0.14), (0, 0.01, 0.02), P["monitor"], col, m)
        box(f"{g.name}_bbg_kbd", (0.48, 0.18, 0.025), (0, -0.4, 0.76), P["black"], col, g)
        for k, (kx, c) in enumerate(((-0.17, "#F2C230"), (-0.08, "#E74C3C"), (0.12, "#2ECC71"))):
            box(f"{g.name}_bbg_key{k}", (0.07, 0.12, 0.008), (kx, -0.4, 0.785), mat(c, 0.4, emit=0.4), col, g, bevel=0)
    else:
        box(f"{g.name}_kbd", (0.44, 0.15, 0.02), (0, -0.4, 0.76), P["monitor"], col, g)
        build_plant_small(f"{g.name}_plant", (0.82, -0.85, 0.76), P, col, g)
    box(f"{g.name}_mouse", (0.06, 0.1, 0.02), (0.33, -0.4, 0.76), P["monitor"], col, g)
    box(f"{g.name}_mug", (0.08, 0.08, 0.1), (-0.8, -0.45, 0.76), mat(lk["accent"], 0.5), col, g)
    office_chair(f"Chair_{name}", (seat.x, seat.y), 0, lk["top"], z, P, col)
    return g


def hash_name(name):
    return sum(map(ord, name))


def label_color_safe(look):
    for key in ("top", "accent"):
        r, gg, b, _ = hex_rgba(look[key])
        if 0.2126 * r + 0.7152 * gg + 0.0722 * b > 0.08:
            return look[key]
    return "#FFFFFF"


def build_plant_small(name, loc, P, col, parent=None):
    g = empty(name, loc, 0, col, parent)
    box(f"{name}_pot", (0.14, 0.14, 0.12), (0, 0, 0), P["pot"], col, g, bevel=0.005)
    box(f"{name}_leaf", (0.18, 0.18, 0.18), (0, 0, 0.12), P["leaf"], col, g, bevel=0.005)
    return g


def bookshelf(name, loc, yaw, P, col, z=0.0):
    g = empty(name, (loc[0], loc[1], z), yaw, col)
    wood = mat("#7A5434", 0.6)
    box(f"{name}_back", (1.0, 0.04, 1.9), (0, 0.16, 0), wood, col, g)
    for sx in (-0.5, 0.5):
        box(f"{name}_side", (0.04, 0.36, 1.9), (sx, 0, 0), wood, col, g)
    books = ("#C0392B", "#2980B9", "#27AE60", "#F39C12", "#8E44AD", "#2C3E50", "#D35400")
    for i in range(4):
        zz = 0.05 + i * 0.46
        box(f"{name}_shelf{i}", (1.0, 0.36, 0.03), (0, 0, zz), wood, col, g)
        x = -0.44
        for j in range(7 - i % 2):
            w = 0.07 + (_h(i, j) % 3) * 0.02
            hgt = 0.24 + (_h(j, i) % 4) * 0.03
            box(f"{name}_book{i}{j}", (w, 0.24, hgt), (x + w / 2, -0.02, zz + 0.03),
                mat(books[(i * 3 + j) % len(books)], 0.7), col, g, bevel=0.003)
            x += w + 0.015
    return g


def _h(*v):
    return _hash(*v)


def sofa(name, loc, yaw, color_hex, col, z=0.0, length=2.0):
    g = empty(name, (loc[0], loc[1], z), yaw, col)
    m, m2 = mat(color_hex, 0.85), mat("#2B2F36", 0.5)
    box(f"{name}_base", (length, 0.85, 0.42), (0, 0, 0.05), m, col, g)
    box(f"{name}_back", (length, 0.22, 0.5), (0, 0.32, 0.47), m, col, g)
    for sx in (-length / 2 + 0.1, length / 2 - 0.1):
        box(f"{name}_arm", (0.2, 0.85, 0.3), (sx, 0, 0.47), m, col, g)
    n = max(2, int(length / 0.75))
    for i in range(n):
        x = -length / 2 + 0.2 + (length - 0.4) * (i + 0.5) / n
        box(f"{name}_cush{i}", ((length - 0.5) / n, 0.6, 0.1), (x, -0.06, 0.47), mat(color_hex, 0.9), col, g, bevel=0.03)
    for sx in (-length / 2 + 0.1, length / 2 - 0.1):
        box(f"{name}_foot", (0.08, 0.08, 0.05), (sx, 0, 0), m2, col, g)
    return g


def rug(name, rect, z, color_hex, border_hex, col):
    x0, y0, x1, y1 = rect
    box(f"{name}_border", (x1 - x0, y1 - y0, 0.012), ((x0 + x1) / 2, (y0 + y1) / 2, z), mat(border_hex, 0.95), col, bevel=0)
    box(f"{name}_mid", (x1 - x0 - 0.3, y1 - y0 - 0.3, 0.014), ((x0 + x1) / 2, (y0 + y1) / 2, z), mat(color_hex, 0.95), col, bevel=0)


# ------------------------------------------------------------- lantai 1

def build_trading_floor(data, P, M, col, agents_col):
    z = 0.0
    rect_floor("F1_Floor_Trading", (X0, Y0, CORRIDOR_X[1], Y1), z, M["oak"], col)
    # video wall melengkung di tengah, layar menghadap meja (+Y)
    vw = curved_screen("F1_VideoWall", 7.2, 1.9, 6.5, (-4.25, VIDEO_WALL_Y, 0.95), 180, M["chart_big"],
                       mat("#15171C", 0.4), col)
    box("F1_VideoWall_pillar", (0.5, 0.22, 0.95), (-4.25, VIDEO_WALL_Y - 0.15, 0), P["desk_leg"], col)
    box("F1_VideoWall_base", (2.4, 0.7, 0.06), (-4.25, VIDEO_WALL_Y - 0.15, 0), P["desk_leg"], col)
    # sisi belakang (menghadap kamera): logo + ticker
    logo = text("F1_VideoWall_logo", "QUANTBOT", (-4.25, VIDEO_WALL_Y - 0.09, 1.85), 0.45,
                P["cyan"], col, yaw_deg=0)
    logo.data.extrude = 0.02
    text("F1_VideoWall_ticker", "BTC 72,140 +2.4%   ETH 3,920 +1.1%",
         (-4.25, VIDEO_WALL_Y - 0.09, 1.45), 0.15, P["green"], col, yaw_deg=0)
    del vw
    # sembilan meja Trade Executor
    for i, a in enumerate(data["executors"]):
        seat = Vector((EXEC_COLS[i % 3], EXEC_ROWS[i // 3]))
        trader_desk(a, seat, z, P, M, collection("F1_Desks", col), executor=True)
    # dinding kiri: watchlist kripto
    n = len(CRYPTO_LOGOS)
    deco = collection("F1_Decor", col)
    for i, sym in enumerate(CRYPTO_LOGOS):
        y = (i - (n - 1) / 2) * 1.3 + 0.8
        g = empty(f"Logo_{sym}", (X0 + 0.04, y, 2.35), 90, deco)
        crypto_logo(sym, g, deco, r=0.32)
        text(f"Logo_{sym}_label", CRYPTO_NAMES[sym], (0, -0.03, -0.5), 0.09, P["label"], deco, g, yaw_deg=0)
    text("Logo_Wall_Title", "WATCHLIST", (X0 + 0.03, 0.8, 2.95), 0.2, P["label"], deco, yaw_deg=90)
    # ticker LED di dinding belakang
    box("F1_Ticker_strip", (12.5, 0.06, 0.38), (-4.5, Y1 - 0.04, 2.9), P["black"], deco, bevel=0.01)
    text("F1_Ticker_text", "BTC 72,140 +2.4%    ETH 3,920 +1.1%    SOL 188.4 -0.6%    XRP 2.31 +3.8%    "
         "BNB 642 +0.4%    ONDO 1.42 +6.1%    LINK 24.8 +1.9%", (-4.5, Y1 - 0.08, 2.98), 0.16, P["green"], deco,
         yaw_deg=0)
    painting("Banner_HODL", "HODL", (-4.25, Y1 - 0.02, 2.2), (1.3, 0.57), deco, frame_hex="#2D3138", emit=1.2)
    for i, (x, y) in enumerate(((-10.4, 6.4), (-10.4, -6.4), (-2.6, -6.4))):
        build_plant(f"F1_Plant_{i}", (x, y, 0), P, deco)
    # tangga ke lantai 2
    sx0, sy0, sx1, sy1 = STAIRS
    steps = 20
    run = (sy1 - sy0) / steps
    for i in range(steps):
        uv_box(f"Stair_{i:02d}", (sx1 - sx0, run, FH / steps * (i + 1)), ((sx0 + sx1) / 2, sy0 + run * (i + 0.5), 0),
               M["walnut"], col)
    for x in (sx0 - 0.03, sx1 + 0.03):
        for i in range(0, steps, 4):
            box(f"Stair_post_{x:+.1f}_{i}", (0.04, 0.04, 0.9), (x, sy0 + run * (i + 0.5), FH / steps * (i + 1)), P["desk_leg"], col)
    rail_len = math.hypot(sy1 - sy0, FH)
    for x in (sx0 - 0.03, sx1 + 0.03):
        box(f"Stair_rail_{x:+.1f}", (0.05, rail_len, 0.05), (x, (sy0 + sy1) / 2, FH / 2 + 0.85), P["desk_leg"], col,
            rot=(math.atan2(FH, sy1 - sy0), 0, 0), bevel=0)


def build_meeting_room(data, P, M, col):
    x0, y0, x1, y1 = MEETING
    rect_floor("F1_Floor_Meeting", MEETING, 0.0, M["teak"], col)
    glass_wall("F1_Meet_W", (x0, y0), (x0, y1), 0, 3.2, P, col,
               door=((MEET_DOOR_Y - 0.6 - y0) / (y1 - y0), (MEET_DOOR_Y + 0.6 - y0) / (y1 - y0)))
    # meja rapat + kursi
    box("Meet_Table", (TABLE_W, TABLE_L, 0.06), (TABLE_C.x, TABLE_C.y, 0.71), mat("#4E3520", 0.45), col, bevel=0.02)
    for dy in (-TABLE_L / 2 + 0.5, TABLE_L / 2 - 0.5):
        box(f"Meet_Table_leg{dy:+.0f}", (0.5, 0.12, 0.71), (TABLE_C.x, TABLE_C.y + dy, 0), P["desk_leg"], col)
    box("Meet_Table_stripe", (0.1, TABLE_L - 0.3, 0.005), (TABLE_C.x, TABLE_C.y, 0.77), P["cyan"], col, bevel=0)
    for label, x, m in (("BULL", WEST_SEAT_X + 0.5, P["green"]), ("BEAR", EAST_SEAT_X - 0.5, P["red"])):
        tag = text(f"Camp_{label}", label, (x, TABLE_C.y - TABLE_L / 2 + 0.25, 0.775), 0.18, m, col,
                   standing=False, yaw_deg=0)
        tag.data.extrude = 0.01
    # LCD besar sebagai papan tulis presentasi
    cx = TABLE_C.x
    box("Meet_LCD_frame", (4.4, 0.08, 2.5), (cx, y1 - 0.05, 0.75), P["monitor"], col, bevel=0.02)
    screen_panel("Meet_LCD_screen", 4.2, 2.3, (cx, y1 - 0.1, 0.85), M["slide"], col)
    text("Meet_LCD_title", "WEEKLY DESK REVIEW  -  BTC/USDT", (cx - 1.95, y1 - 0.11, 2.83), 0.13, P["white"], col,
         yaw_deg=0, align="LEFT")
    text("Meet_LCD_bull", "BULL", (cx + 0.85, y1 - 0.11, 2.45), 0.12, P["green"], col, yaw_deg=0)
    text("Meet_LCD_bear", "BEAR", (cx + 1.6, y1 - 0.11, 2.45), 0.12, P["red"], col, yaw_deg=0)
    box("Meet_LCD_stand", (0.6, 0.35, 0.75), (cx, y1 - 0.25, 0), P["desk_leg"], col)
    box("Meet_Credenza", (1.8, 0.45, 0.7), (x1 - 1.2, y1 - 0.3, 0), mat("#6B4A2E", 0.6), col)
    build_plant("Meet_Plant", (x1 - 0.5, y0 + 0.5, 0), P, col)
    painting("Painting_To_The_Moon", "To_The_Moon", (4.65, y1 - 0.03, 1.6), (1.0, 0.75), col)


def build_pantry(P, M, col):
    x0, y0, x1, y1 = PANTRY
    rect_floor("F1_Floor_Pantry", PANTRY, 0.0, M["birch"], col)
    glass_wall("F1_Pantry_W", (x0, y0), (x0, y1), 0, 3.2, P, col, door=(0.6, 0.78))
    # dinding pemisah dengan Meeting Room (padat, untuk lemari gantung)
    box("F1_Pantry_wall", (x1 - x0, 0.15, 2.4), ((x0 + x1) / 2, y1, 0), P["wall"], col, bevel=0.01)
    wy = y1 - 0.08
    cab, top, handle = mat("#F2EFE8", 0.5), mat("#3A3F48", 0.3), mat("#9AA1A8", 0.25, metal=0.8)
    # lemari bawah + countertop sepanjang dinding
    cx0, cx1 = x0 + 0.6, x1 - 1.4
    n = 6
    w = (cx1 - cx0) / n
    for i in range(n):
        x = cx0 + w * (i + 0.5)
        box(f"Pantry_base{i}", (w - 0.02, 0.6, 0.86), (x, wy - 0.32, 0.05), cab, col, bevel=0.01)
        box(f"Pantry_base{i}_h", (0.14, 0.02, 0.025), (x, wy - 0.63, 0.75), handle, col, bevel=0)
        box(f"Pantry_upper{i}", (w - 0.02, 0.35, 0.7), (x, wy - 0.18, 1.6), cab, col, bevel=0.01)
        box(f"Pantry_upper{i}_h", (0.14, 0.02, 0.025), (x, wy - 0.36, 1.66), handle, col, bevel=0)
    box("Pantry_plinth", (cx1 - cx0, 0.55, 0.05), ((cx0 + cx1) / 2, wy - 0.3, 0), top, col, bevel=0)
    box("Pantry_counter", (cx1 - cx0 + 0.04, 0.65, 0.04), ((cx0 + cx1) / 2, wy - 0.32, 0.91), top, col, bevel=0.005)
    # wastafel + keran air
    sx = cx0 + w * 1.5
    box("Pantry_sink", (0.5, 0.38, 0.02), (sx, wy - 0.35, 0.935), mat("#B8BEC4", 0.2, metal=0.9), col, bevel=0)
    box("Pantry_sink_in", (0.44, 0.32, 0.015), (sx, wy - 0.35, 0.94), mat("#7E858C", 0.25, metal=0.9), col, bevel=0)
    chrome = mat("#D9DEE3", 0.15, metal=1.0)
    cyl("Pantry_faucet", 0.022, 0.32, (sx, wy - 0.12, 0.95), chrome, col)
    box("Pantry_faucet_spout", (0.03, 0.2, 0.03), (sx, wy - 0.21, 1.24), chrome, col, bevel=0)
    cyl("Pantry_faucet_tip", 0.018, 0.05, (sx, wy - 0.3, 1.2), chrome, col)
    # microwave
    mx = cx0 + w * 3.5
    box("Pantry_microwave", (0.52, 0.38, 0.3), (mx, wy - 0.3, 0.95), mat("#2B2F36", 0.4), col, bevel=0.01)
    box("Pantry_microwave_door", (0.34, 0.01, 0.22), (mx - 0.06, wy - 0.495, 0.99), mat("#11141A", 0.1), col, bevel=0)
    box("Pantry_microwave_panel", (0.1, 0.01, 0.22), (mx + 0.18, wy - 0.495, 0.99), mat("#35C9FF", 0.3, emit=1.5), col, bevel=0)
    # mesin kopi kecil
    box("Pantry_coffee", (0.25, 0.3, 0.38), (cx0 + w * 5.3, wy - 0.3, 0.95), mat("#1A1C20", 0.35), col)
    # kulkas
    fx = x1 - 0.75
    box("Pantry_fridge", (0.85, 0.75, 1.95), (fx, wy - 0.42, 0), mat("#D5D9DD", 0.25, metal=0.6), col, bevel=0.02)
    box("Pantry_fridge_split", (0.86, 0.01, 0.02), (fx, wy - 0.8, 1.25), mat("#8A9096", 0.3), col, bevel=0)
    for zz, hh in ((1.35, 0.45), (0.35, 0.75)):
        box(f"Pantry_fridge_h{zz}", (0.03, 0.04, hh), (fx - 0.35, wy - 0.82, zz), handle, col, bevel=0)
    # dispenser air galon
    dx, dy = x0 + 0.6, y0 + 0.7
    box("Pantry_dispenser", (0.34, 0.34, 1.0), (dx, dy, 0), mat("#F5F5F2", 0.4), col, bevel=0.02)
    box("Pantry_dispenser_tap", (0.14, 0.03, 0.08), (dx, dy - 0.18, 0.78), mat("#2980B9", 0.3), col, bevel=0)
    cyl("Pantry_gallon", 0.15, 0.42, (dx, dy, 1.0), mat("#7EC8F2", 0.05, glass=True), col)
    cyl("Pantry_gallon_cap", 0.05, 0.05, (dx, dy, 1.42), mat("#2980B9", 0.3), col)
    # meja makan kecil + bangku
    tx, ty = 7.5, -4.6
    cyl("Pantry_table", 0.55, 0.04, (tx, ty, 0.74), mat("#E4D5B0", 0.5), col, segs=32)
    cyl("Pantry_table_leg", 0.05, 0.74, (tx, ty, 0), P["desk_leg"], col)
    for i in range(3):
        a = math.radians(90 + i * 120)
        px, py = tx + 0.85 * math.cos(a), ty + 0.85 * math.sin(a)
        cyl(f"Pantry_stool{i}", 0.18, 0.05, (px, py, 0.48), mat("#C0392B", 0.6), col, segs=16)
        cyl(f"Pantry_stool{i}_leg", 0.03, 0.48, (px, py, 0), P["desk_leg"], col)
    text("Pantry_sign", "PANTRY", (x0 + 0.25, y0 + 0.3, 0.005), 0.28, P["label"], col, standing=False,
         align="LEFT", yaw_deg=0)


# ------------------------------------------------------------- lantai 2

def lead_rooms(data, P, M, col):
    rooms = {}
    woods = ("teak", "ash", "walnut", "oak", "teak", "ash", "walnut", "oak", "teak")
    for i, a in enumerate(data["leads"]):
        r, c = divmod(i, 3)
        (rx0, rx1), (ry0, ry1) = LEAD_COLS[c], LEAD_ROWS[r]
        cx, cy = (rx0 + rx1) / 2, (ry0 + ry1) / 2
        rc = collection(f"F2_Room_{a['id']}", col)
        rect_floor(f"F2_Floor_{a['id']}", (rx0, ry0, rx1, ry1), FH, M[woods[i]], rc)
        # dinding kaca: sisi timur (pintu) dan sisi selatan
        glass_wall(f"F2_{a['id']}_E", (rx1, ry0), (rx1, ry1), FH, 2.8, P, rc, door=(0.12, 0.38))
        if ry0 > Y0:
            glass_wall(f"F2_{a['id']}_S", (rx0, ry0), (rx1, ry0), FH, 2.8, P, rc)
        seat = Vector((cx, cy + 0.7))
        trader_desk(a, seat, FH, P, M, rc, executor=False)
        bookshelf(f"F2_{a['id']}_shelf", (rx0 + 0.3, cy + 0.6), 90, P, rc, z=FH)
        build_plant(f"F2_{a['id']}_plant", (rx1 - 0.45, ry1 - 0.45, FH), P, rc)
        rug(f"F2_{a['id']}_rug", (cx - 1.1, cy - 1.0, cx + 1.1, cy + 1.4), FH, a["look"]["top"], "#2B2F36", rc)
        sign = text(f"F2_{a['id']}_sign", a["id"], (rx0 + 0.2, ry0 + 0.3, FH + 0.02), 0.32,
                    mat(label_color_safe(a["look"]), 0.4, emit=1.0), rc, standing=False, align="LEFT", yaw_deg=0)
        sign.data.extrude = 0.01
        text(f"F2_{a['id']}_sign_role", "LEAD", (rx0 + 0.2, ry0 + 0.62, FH + 0.02), 0.13, P["label"], rc,
             standing=False, align="LEFT", yaw_deg=0)
        rooms[a["id"]] = (seat, (rx0, ry0, rx1, ry1))
    return rooms


def build_hall(P, M, col):
    x0, y0, x1, y1 = HALL
    hx0, hy0, hx1, hy1 = STAIR_HOLE
    rect_floor("F2_Floor_Hall_W", (x0, y0, hx0, y1), FH, M["oak"], col)
    rect_floor("F2_Floor_Hall_N", (hx0, hy1, x1, y1), FH, M["oak"], col)
    rect_floor("F2_Floor_Hall_S", (hx0, y0, x1, hy0), FH, M["oak"], col)
    for p0, p1 in (((hx0, hy0), (hx0, hy1)),):   # sisi utara terbuka = jalur keluar tangga
        p0, p1 = Vector(p0), Vector(p1)
        mid, length = (p0 + p1) / 2, (p1 - p0).length
        ang = math.atan2((p1 - p0).y, (p1 - p0).x)
        box(f"F2_StairRail_{p0.x:+.1f}{p0.y:+.1f}", (length, 0.05, 0.05), (mid.x, mid.y, FH + 0.95), P["desk_leg"], col,
            rot=(0, 0, ang), bevel=0)
        box(f"F2_StairGlass_{p0.x:+.1f}{p0.y:+.1f}", (length, 0.02, 0.9), (mid.x, mid.y, FH), P["glass"], col,
            rot=(0, 0, ang), bevel=0)
    coin_hologram("Holo_BTC", (1.6, 4.6), col, "BTC")
    bpy.data.objects["Holo_BTC"].location.z = FH
    sofa("F2_Hall_sofa", (1.2, 1.2), -90, "#5B6C8F", col, z=FH, length=1.8)
    build_plant("F2_Hall_plant", (1.0, 6.4, FH), P, col)
    text("F2_Hall_sign", "LOBBY", (x0 + 0.2, hy1 + 0.4, FH + 0.02), 0.26, P["label"], col, standing=False,
         align="LEFT", yaw_deg=0)


def build_owner_room(data, P, M, col):
    x0, y0, x1, y1 = OWNER
    rect_floor("F2_Floor_Owner", OWNER, FH, M["walnut"], col)
    glass_wall("F2_Owner_W", (x0, y0), (x0, y1), FH, 2.8, P, col, door=(0.35, 0.5))
    glass_wall("F2_Owner_S", (x0, y0), (x1, y0), FH, 2.8, P, col, door=(0.05, 0.2))
    rug("F2_Owner_rug", (5.0, 0.3, 10.2, 4.2), FH, "#C9A66B", "#3B2A1E", col)
    # set DJ: booth + turntable + mixer + speaker + LED wall
    bx, by = 8.2, 5.25
    z = FH
    booth = mat("#15171C", 0.35)
    box("DJ_booth", (1.9, 0.7, 0.98), (bx, by, z), booth, col, bevel=0.02)
    box("DJ_booth_led", (1.8, 0.02, 0.06), (bx, by - 0.36, z + 0.8), P["cyan"], col, bevel=0)
    logo = text("DJ_booth_logo", "QUANTBOT", (bx, by - 0.37, z + 0.35), 0.2, mat("#FF006E", 0.3, emit=3.0), col, yaw_deg=0)
    logo.data.extrude = 0.01
    for k, tx in enumerate((-0.55, 0.55)):
        box(f"DJ_tt{k}", (0.48, 0.38, 0.06), (bx + tx, by, z + 0.98), mat("#2B2F36", 0.4), col, bevel=0.005)
        plat = empty(f"DJ_platter{k}", (bx + tx - 0.05, by, z + 1.04), 0, col)
        cyl(f"DJ_platter{k}_disc", 0.16, 0.015, (0, 0, 0), mat("#0B0B0E", 0.3), col, plat, segs=32)
        box(f"DJ_platter{k}_label", (0.1, 0.03, 0.006), (0, 0, 0.015), mat("#FF006E" if k else "#06D6A0", 0.4, emit=1.0), col, plat, bevel=0)
        fc = plat.driver_add("rotation_euler", 2)
        fc.driver.expression = "frame * 0.35"
        box(f"DJ_tt{k}_arm", (0.02, 0.2, 0.02), (bx + tx + 0.17, by + 0.05, z + 1.05), P["steel"] if "steel" in P else P["desk_leg"], col, bevel=0)
    box("DJ_mixer", (0.3, 0.34, 0.07), (bx, by, z + 0.98), mat("#1E2026", 0.4), col, bevel=0.005)
    for i in range(6):
        cyl(f"DJ_knob{i}", 0.015, 0.025, (bx - 0.08 + (i % 3) * 0.08, by + 0.06 - (i // 3) * 0.08, z + 1.05),
            mat(("#FF006E", "#06D6A0", "#FFBE0B")[i % 3], 0.4, emit=0.8), col, segs=10)
    box("DJ_fader", (0.12, 0.02, 0.012), (bx, by - 0.12, z + 1.05), P["white"], col, bevel=0)
    box("DJ_laptop", (0.34, 0.24, 0.015), (bx + 1.25, by + 0.05, z + 0.98), P["steel"] if "steel" in P else P["white"], col)
    for sx in (-1.45, 1.45):
        sp = empty(f"DJ_speaker{sx:+.0f}", (bx + sx, by + 0.15, z), 0, col)
        box(f"{sp.name}_box", (0.5, 0.45, 1.35), (0, 0, 0), booth, col, sp)
        for k, (zz, r) in enumerate(((0.38, 0.17), (0.92, 0.1))):
            cyl(f"{sp.name}_cone{k}", r, 0.03, (0, -0.24, zz), mat("#3A3F48", 0.4), col, sp,
                segs=24, rot=(math.radians(90), 0, 0))
    box("DJ_ledwall", (3.6, 0.06, 1.6), (bx, y1 - 0.05, z + 1.1), mat("#111216", 0.4), col, bevel=0.01)
    screen_panel("DJ_ledwall_screen", 3.45, 1.45, (bx, y1 - 0.09, z + 1.175), M["led"], col)
    # meja kerja owner: meja besar + kursi eksekutif + curved monitor
    dx, dy = 5.9, 1.55
    desk = mat("#3B2A1E", 0.4)
    box("Owner_desk", (2.4, 1.0, 0.06), (dx, dy - 0.7, z + 0.72), desk, col, bevel=0.01)
    box("Owner_desk_side", (0.06, 0.95, 0.72), (dx - 1.15, dy - 0.7, z), desk, col)
    box("Owner_desk_cab", (0.5, 0.9, 0.72), (dx + 0.9, dy - 0.7, z), desk, col)
    box("Owner_desk_front", (2.3, 0.04, 0.55), (dx, dy - 1.18, z + 0.17), desk, col)
    text("Owner_desk_name", "FOUNDER", (dx, dy - 1.21, z + 0.35), 0.14, mat("#D4A017", 0.3, emit=0.8), col, yaw_deg=0)
    box("Owner_mon_base", (0.32, 0.22, 0.02), (dx, dy - 0.95, z + 0.78), P["monitor"], col)
    box("Owner_mon_neck", (0.06, 0.05, 0.22), (dx, dy - 0.99, z + 0.8), P["monitor"], col)
    curved_screen("Owner_curve", 1.35, 0.55, 1.1, (dx, dy - 0.9, z + 0.98), 180, M["chart"][0], P["monitor"], col)
    box("Owner_kbd", (0.46, 0.16, 0.02), (dx, dy - 0.48, z + 0.78), P["monitor"], col)
    box("Owner_mouse", (0.06, 0.1, 0.02), (dx + 0.35, dy - 0.48, z + 0.78), P["monitor"], col)
    exec_chair = office_chair("Owner_chair", (dx, dy), 0, "#2B1D14", z, P, col)
    bpy.data.objects["Owner_chair_back"].scale = (1.1, 1.0, 1.35)
    del exec_chair
    sofa("Owner_sofa", (10.3, 1.6), -90, "#3B2A1E", col, z=z, length=2.4)
    painting("Painting_Sunset_Peaks", "Sunset_Peaks", (5.4, y1 - 0.03, z + 1.5), (1.6, 1.2), col)
    build_plant("Owner_plant", (x1 - 0.5, y1 - 0.5, z), P, col)
    text("Owner_sign", "FOUNDER ROOM", (x0 + 0.25, y0 + 0.35, z + 0.02), 0.28, mat("#D4A017", 0.3, emit=0.8), col,
         standing=False, align="LEFT", yaw_deg=0)
    return Vector((bx, by + 0.6))


def build_game_room(P, M, col):
    x0, y0, x1, y1 = GAME
    z = FH
    rect_floor("F2_Floor_Game", GAME, FH, M["ash"], col)
    glass_wall("F2_Game_W", (x0, y0), (x0, y1), FH, 2.8, P, col, door=(0.8, 0.95))
    rug("F2_Game_rug", (8.0, -5.4, 10.7, -1.6), z, "#3A86FF", "#1B1F3B", col)
    # dua mesin arcade
    for k, ax in enumerate((4.6, 5.5)):
        g = empty(f"Arcade_{k}", (ax, -1.55, z), 0, col)
        body = mat(("#8338EC", "#FF006E")[k], 0.5)
        box(f"{g.name}_body", (0.72, 0.75, 1.75), (0, 0, 0), body, col, g)
        screen_panel(f"{g.name}_screen", 0.56, 0.48, (0, -0.39, 1.05), M["game"][k], col, g)
        box(f"{g.name}_panel", (0.68, 0.3, 0.06), (0, -0.48, 0.92), mat("#1B1F3B", 0.4), col, g,
            rot=(math.radians(-15), 0, 0))
        cyl(f"{g.name}_stick", 0.012, 0.08, (-0.15, -0.5, 0.98), P["black"], col, g)
        sphere(f"{g.name}_ball", 0.03, (-0.15, -0.5, 1.07), mat("#E74C3C", 0.3), col, g)
        for b in range(3):
            cyl(f"{g.name}_btn{b}", 0.022, 0.02, (0.05 + b * 0.08, -0.5, 0.97),
                mat(("#F1C40F", "#2ECC71", "#3498DB")[b], 0.3, emit=0.8), col, g, segs=12)
        box(f"{g.name}_marquee", (0.7, 0.04, 0.2), (0, -0.38, 1.62), mat("#FFBE0B", 0.3, emit=2.0), col, g, bevel=0)
    # meja ping pong
    tx, ty = 6.2, -4.6
    box("PingPong_top", (1.525, 2.74, 0.05), (tx, ty, z + 0.71), mat("#1E6B4A", 0.5), col, bevel=0.005)
    box("PingPong_line", (0.02, 2.7, 0.003), (tx, ty, z + 0.76), P["white"], col, bevel=0)
    box("PingPong_edge", (1.53, 0.02, 0.003), (tx, ty + 1.36, z + 0.76), P["white"], col, bevel=0)
    box("PingPong_net", (1.7, 0.01, 0.15), (tx, ty, z + 0.76), mat("#F5F5F5", 0.8), col, bevel=0)
    for dx in (-0.65, 0.65):
        for dy in (-1.1, 1.1):
            box("PingPong_leg", (0.05, 0.05, 0.71), (tx + dx, ty + dy, z), P["desk_leg"], col)
    for k, (px, py) in enumerate(((tx + 0.3, ty - 1.1), (tx - 0.3, ty + 1.15))):
        cyl(f"Paddle{k}", 0.08, 0.01, (px, py, z + 0.765), mat("#C0392B", 0.5), col, segs=16)
    sphere("PingPong_ball", 0.02, (tx + 0.2, ty - 0.4, z + 0.8), P["white"], col)
    # sofa + TV + konsol
    sofa("Game_sofa", (9.35, -4.4), 180, "#FF7F50", col, z=z, length=2.4)
    box("Game_TV", (2.2, 0.06, 1.25), (9.35, y1 - 0.05, z + 1.0), P["monitor"], col, bevel=0.01)
    screen_panel("Game_TV_screen", 2.08, 1.12, (9.35, y1 - 0.1, z + 1.06), M["game"][2], col)
    box("Game_console_table", (1.6, 0.4, 0.45), (9.35, y1 - 0.3, z), mat("#2B2F36", 0.5), col)
    box("Game_console", (0.36, 0.28, 0.08), (9.0, y1 - 0.3, z + 0.45), P["white"], col)
    for k, (bx, by, c) in enumerate(((7.9, -2.5, "#06D6A0"), (10.6, -2.6, "#8338EC"))):
        sphere(f"Game_beanbag{k}", 0.38, (bx, by, z + 0.25), mat(c, 0.9), col)
        bpy.data.objects[f"Game_beanbag{k}"].scale = (1.0, 1.0, 0.65)
    # papan dart + neon
    for k, (r, c) in enumerate(((0.25, "#1A1A1A"), (0.2, "#E8D8B0"), (0.12, "#C0392B"), (0.05, "#27AE60"))):
        cyl(f"Dart_{k}", r, 0.02 + k * 0.005, (x1 - 0.04, -4.2, z + 1.7), mat(c, 0.6), col, segs=32,
            rot=(0, math.radians(-90), 0))
    neon = text("Game_neon", "GAME ROOM", (6.9, y1 - 0.06, z + 2.25), 0.3, mat("#FF006E", 0.3, emit=5.0), col, yaw_deg=0)
    neon.data.extrude = 0.015
    text("Game_sign", "GAME ROOM", (x0 + 0.25, y0 + 0.35, z + 0.02), 0.28, P["label"], col, standing=False,
         align="LEFT", yaw_deg=0)


# ------------------------------------------------------------ cangkang gedung

def build_shell(P, M, f1, f2, roof):
    facades = (collection("Facade_1", f1), collection("Facade_2", f2))
    conc = mat("#9EA3A8", 0.7)
    wall = mat("#E9E4DA", 0.85)
    frame = mat("#2D3138", 0.4, metal=0.5)
    # pelat lantai 2 (beton) mengikuti lubang tangga
    hx0, hy0, hx1, hy1 = STAIR_HOLE
    for name, (a, b, c, d) in (("W", (X0, Y0, hx0, Y1)), ("N", (hx0, hy1, X1, Y1)), ("S", (hx0, Y0, hx1, hy0)),
                               ("E", (hx1, Y0, X1, hy1))):
        box(f"F2_Slab_{name}", (c - a, d - b, 0.22), ((a + c) / 2, (b + d) / 2, FH - 0.26), conc, f2, bevel=0)
    # dinding luar padat: belakang & kiri (dua lantai), dengan jendela di sisi dalam
    for floor, col in ((0, f1), (1, f2)):
        z0 = floor * FH
        h = FH if floor == 0 else FH + 0.6
        box(f"Wall_Back_{floor}", (X1 - X0 + 2 * WALL_T, WALL_T, h), (0, Y1 + WALL_T / 2, z0), wall, col, bevel=0)
        box(f"Wall_Left_{floor}", (WALL_T, Y1 - Y0, h), (X0 - WALL_T / 2, 0, z0), wall, col, bevel=0)
        for i, x in enumerate((-8.5, -1.5, 5.5)):
            if floor == 0 and abs(x + 4.5) < 4:
                continue
            box(f"Win_Back_{floor}_{i}", (2.2, 0.03, 1.4), (x, Y1 - 0.01, z0 + 1.1), M["sky"], col, bevel=0)
            box(f"Win_Back_{floor}_{i}_frame", (2.34, 0.05, 0.08), (x, Y1 - 0.02, z0 + 1.03), frame, col, bevel=0)
        for i, y in enumerate((-4.5, 4.5)):
            if floor == 0:
                continue
            box(f"Win_Left_{floor}_{i}", (0.03, 2.0, 1.4), (X0 + 0.01, y, z0 + 1.1), M["sky"], col, bevel=0)
        # tirai kaca depan & kanan
        top = z0 + FH - (0.26 if floor == 0 else -0.6)
        hgt = top - z0
        for side in ("front", "right"):
            if side == "front":
                p0, p1, n = Vector((X0, Y0)), Vector((X1, Y0)), 12
            else:
                p0, p1, n = Vector((X1, Y0)), Vector((X1, Y1)), 8
            d = p1 - p0
            ang = math.atan2(d.y, d.x)
            for i in range(n):
                a, b = p0 + d * (i / n), p0 + d * ((i + 1) / n)
                mid = (a + b) / 2
                entrance = side == "front" and floor == 0 and ENTRANCE[0] <= mid.x <= ENTRANCE[1]
                fc = facades[floor]
                if not entrance:
                    box(f"Curtain_{side}_{floor}_{i}", ((b - a).length, 0.03, hgt), (mid.x, mid.y, z0), P["glass"], fc,
                        rot=(0, 0, ang), bevel=0)
                box(f"Mullion_{side}_{floor}_{i}", (0.07, 0.1, hgt), (a.x, a.y, z0), frame, fc, bevel=0)
            box(f"Mullion_{side}_{floor}_end", (0.07, 0.1, hgt), (p1.x, p1.y, z0), frame, facades[floor], bevel=0)
            box(f"Spandrel_{side}_{floor}", (d.length, 0.12, 0.28), ((p0 + p1).x / 2, (p0 + p1).y / 2, z0 + FH - 0.28),
                frame, facades[floor], rot=(0, 0, ang), bevel=0)
    # kanopi pintu masuk + papan nama
    ex = 1.0
    box("Entrance_canopy", (4.2, 1.8, 0.2), (ex, Y0 - 0.8, 2.9), frame, f1, bevel=0.02)
    sign = text("Entrance_sign", "QUANTBOT HQ", (ex, Y0 - 1.72, 2.92), 0.2, P["cyan"], f1, yaw_deg=0)
    sign.data.extrude = 0.01
    for sx in (-1.9, 1.9):
        box(f"Entrance_post{sx:+.0f}", (0.12, 0.12, 2.9), (ex + sx, Y0 - 1.6, 0), frame, f1)
    # atap (disembunyikan default supaya lantai 2 terlihat)
    box("Roof_slab", (X1 - X0 + 2 * WALL_T, Y1 - Y0 + 2 * WALL_T, 0.3), (0, 0, 2 * FH + 0.6), conc, roof, bevel=0)
    for i, (a, b) in enumerate((((X0, Y0), (X1, Y0)), ((X1, Y0), (X1, Y1)), ((X0, Y1), (X1, Y1)), ((X0, Y0), (X0, Y1)))):
        a, b = Vector(a), Vector(b)
        mid, length = (a + b) / 2, (b - a).length
        ang = math.atan2((b - a).y, (b - a).x)
        box(f"Roof_parapet{i}", (length + 0.5, 0.25, 0.6), (mid.x, mid.y, 2 * FH + 0.9), wall, roof, rot=(0, 0, ang), bevel=0)
    for i, (x, y) in enumerate(((-6, 3), (-2, 3), (6, -3))):
        box(f"Roof_AC{i}", (1.4, 1.0, 0.9), (x, y, 2 * FH + 0.9), mat("#C8CDD2", 0.4, metal=0.4), roof)
    rsign = text("Roof_sign", "QUANTBOT", (0, Y0 + 0.4, 2 * FH + 1.6), 1.4, P["cyan"], roof, yaw_deg=0)
    rsign.data.extrude = 0.06
    box("Roof_sign_frame", (9.2, 0.15, 0.2), (0, Y0 + 0.5, 2 * FH + 1.5), frame, roof)
    # lampu plafon lantai 1 (di bawah pelat lantai 2)
    for i, (x, y) in enumerate(((-7.5, 3.5), (-1.0, 3.5), (-7.5, -3.5), (-1.0, -3.5), (7.5, 3.0), (7.5, -3.8))):
        ld = bpy.data.lights.new(f"F1_Light_{i}", "AREA")
        ld.energy = 900
        ld.size = 4.5
        lo = bpy.data.objects.new(f"F1_Light_{i}", ld)
        f1.objects.link(lo)
        lo.location = (x, y, FH - 0.45)


# -------------------------------------------------------------- eksterior

def build_exterior(P, M, col):
    uv_box("Ground_grass", (90, 80, 0.3), (2, 6, -0.32), M["grass"], col, tile=1.0)
    uv_box("Plaza", (26, 3.2, 0.06), (0, -8.6, -0.04), M["paver"], col, tile=1.0)
    uv_box("Sidewalk", (90, 2.2, 0.12), (2, -11.3, -0.04), M["paver"], col, tile=1.0)
    uv_box("Road", (90, 7, 0.04), (2, -15.9, -0.04), M["asphalt"], col, tile=2.0)
    box("Curb", (90, 0.2, 0.16), (2, -12.45, -0.04), mat("#B5B0A5", 0.7), col, bevel=0)
    for i in range(-11, 12):
        box(f"Road_dash{i}", (2.0, 0.18, 0.012), (i * 4.0, -15.9, 0.0), mat("#F2F2EE", 0.6), col, bevel=0)
    for k, y in enumerate((-12.65, -19.2)):
        box(f"Road_edge{k}", (90, 0.12, 0.012), (2, y, 0.0), mat("#F7C948", 0.6), col, bevel=0)
    # jalan masuk + parkiran di kanan gedung
    uv_box("Driveway", (4.0, 3.6, 0.05), (16.0, -10.6, -0.03), M["asphalt"], col, tile=2.0)
    uv_box("Parking", (12, 16, 0.05), (19.0, -0.5, -0.03), M["asphalt"], col, tile=2.0)
    for i in range(6):
        box(f"Park_line{i}", (0.1, 4.2, 0.012), (14.2, -6.5 + i * 2.6, 0.02), mat("#F2F2EE", 0.6), col, bevel=0)
        box(f"Park_lineB{i}", (0.1, 4.2, 0.012), (23.8, -6.5 + i * 2.6, 0.02), mat("#F2F2EE", 0.6), col, bevel=0)
    for k, (cx, cy, c) in enumerate(((15.6, -5.2, "#C0392B"), (15.6, 0.0, "#2C3E50"), (22.4, -2.6, "#F1C40F"),
                                     (22.4, 2.6, "#ECF0F1"))):
        car(f"Car_{k}", (cx, cy), 90 if cx < 19 else -90, c, col)
    # pohon, palem, pagar tanaman, lampu jalan
    for k, (x, y) in enumerate(((-15, 9), (-19, 3), (-16, -3), (-20, -8), (-8, 11.5), (0, 12), (8, 11.5),
                                (14, 11), (26, 8), (27, -6), (-24, 12))):
        oak_tree(f"Tree_{k}", (x, y), col, scale=0.9 + (k % 3) * 0.15)
    for k, x in enumerate(range(-30, 34, 8)):
        if abs(x - 16) < 3:
            continue
        palm_tree(f"Palm_{k}", (x, -10.6), col)
    for k, x in enumerate(range(-28, 34, 10)):
        street_lamp(f"Lamp_{k}", (x + 4, -12.1), col)
    for k, (x0, x1) in enumerate(((-11.5, -1.2), (3.2, 11.5))):
        box(f"Hedge_{k}", (x1 - x0, 0.6, 0.6), ((x0 + x1) / 2, -7.6, 0), P["leaf2"], col, bevel=0.03)
    # monumen logo di plaza
    box("Monument", (4.2, 0.7, 1.2), (-6.5, -9.2, 0), mat("#2B2F36", 0.4), col, bevel=0.03)
    mt = text("Monument_text", "QUANTBOT", (-6.5, -9.57, 0.55), 0.5, P["cyan"], col, yaw_deg=0)
    mt.data.extrude = 0.02
    text("Monument_sub", "AI TRADING HQ", (-6.5, -9.57, 0.25), 0.16, P["white"], col, yaw_deg=0)
    for k, x in enumerate((-2.5, 9.5)):
        box(f"Bench_{k}", (1.6, 0.45, 0.06), (x, -9.4, 0.42), mat("#8B5A2B", 0.6), col)
        for sx in (-0.65, 0.65):
            box(f"Bench_{k}_leg", (0.08, 0.4, 0.42), (x + sx, -9.4, 0), P["desk_leg"], col)
    # gedung tetangga di kejauhan
    for k, (x, w, d, h, c) in enumerate(((-26, 8, 8, 14, "#B7C4CF"), (-12, 10, 7, 22, "#9FB1C2"),
                                         (4, 9, 8, 17, "#C9D3DC"), (18, 8, 8, 26, "#A7B8C8"),
                                         (32, 9, 9, 12, "#BCC8D3"))):
        y = 24 + (k % 2) * 4
        box(f"Neighbor_{k}", (w, d, h), (x, y, 0), mat(c, 0.6), col, bevel=0.05)
        for row in range(int(h / 2.2)):
            box(f"Neighbor_{k}_win{row}", (w - 1.0, 0.05, 0.9), (x, y - d / 2 - 0.02, 1.2 + row * 2.2),
                M["sky"], col, bevel=0)


def oak_tree(name, pos, col, scale=1.0):
    g = empty(name, (pos[0], pos[1], 0), 0, col)
    g.scale = (scale, scale, scale)
    box(f"{name}_trunk", (0.5, 0.5, 2.4), (0, 0, 0), mat("#6B4A2E", 0.8), col, g, bevel=0)
    for i, (dx, dy, dz, s) in enumerate(((0, 0, 2.1, 2.4), (0.7, 0.3, 3.2, 1.4), (-0.6, -0.4, 3.3, 1.3),
                                         (0, 0, 3.9, 1.2))):
        box(f"{name}_leaf{i}", (s, s, s * 0.8), (dx, dy, dz), mat(("#4CAF50", "#3D8B40")[i % 2], 0.85), col, g, bevel=0)


def palm_tree(name, pos, col):
    g = empty(name, (pos[0], pos[1], 0), 0, col)
    trunk = mat("#A67C52", 0.8)
    for i in range(7):
        box(f"{name}_t{i}", (0.32, 0.32, 0.55), (0.06 * i, 0, i * 0.55), trunk, col, g, bevel=0)
    leaf = mat("#2E8B57", 0.8)
    top = Vector((0.42, 0, 3.85))
    for k in range(6):
        a = math.radians(k * 60)
        box(f"{name}_frond{k}", (1.9, 0.38, 0.1), (top.x + math.cos(a) * 0.9, top.y + math.sin(a) * 0.9, top.z - 0.2),
            leaf, col, g, rot=(0, math.radians(18), a), bevel=0)
    for k in range(3):
        sphere(f"{name}_coco{k}", 0.1, (top.x + 0.15 * math.cos(k * 2.1), 0.15 * math.sin(k * 2.1), top.z - 0.15),
               mat("#5C4033", 0.7), col, g)


def street_lamp(name, pos, col):
    g = empty(name, (pos[0], pos[1], 0), 0, col)
    pole = mat("#2D3138", 0.4, metal=0.6)
    box(f"{name}_pole", (0.14, 0.14, 4.2), (0, 0, 0), pole, col, g)
    box(f"{name}_arm", (0.1, 0.9, 0.1), (0, -0.4, 4.1), pole, col, g)
    box(f"{name}_head", (0.35, 0.5, 0.15), (0, -0.85, 3.98), mat("#FFF3C4", 0.3, emit=3.0), col, g)


def car(name, pos, yaw, color_hex, col):
    g = empty(name, (pos[0], pos[1], 0), yaw, col)
    body, glass, tire = mat(color_hex, 0.3, metal=0.4), mat("#26323F", 0.1), mat("#141414", 0.8)
    box(f"{name}_body", (1.8, 4.2, 0.75), (0, 0, 0.3), body, col, g, bevel=0.06)
    box(f"{name}_cabin", (1.6, 2.2, 0.6), (0, 0.2, 1.05), body, col, g, bevel=0.05)
    box(f"{name}_glass", (1.62, 2.0, 0.42), (0, 0.2, 1.12), glass, col, g, bevel=0.02)
    for sx in (-0.85, 0.85):
        for sy in (-1.35, 1.35):
            box(f"{name}_tire", (0.25, 0.7, 0.62), (sx, sy, 0.0), tire, col, g, bevel=0.05)
    for sx in (-0.6, 0.6):
        box(f"{name}_light", (0.35, 0.04, 0.14), (sx, -2.11, 0.75), mat("#FFF8DC", 0.3, emit=1.0), col, g, bevel=0)


# ------------------------------------------------------------- animasi

def pose_dj(t):
    p = pose_stand(t)
    s = math.sin(t * 0.55)
    p["arm.L"] = -1.15 + 0.22 * s
    p["arm.R"] = -1.15 - 0.22 * math.sin(t * 0.55 + 1.4)
    p["head"] = 0.12 * abs(math.sin(t * 0.26))
    p["root_z"] = -0.035 * abs(math.sin(t * 0.26))
    return p


class SeatPlan:
    """Agen yang tetap di tempat (Lead di ruangnya, Owner di booth DJ)."""

    def __init__(self, agent_id, seat, z, mode="type", yaw=0.0):
        self.id, self.seat, self.z, self.mode, self._yaw = agent_id, seat, z, mode, yaw
        self.phase = hash_name(agent_id) % 37

    def loc(self, f):
        return self.seat

    def yaw(self, f):
        return self._yaw

    def pose(self, f, speaking, look_yaw):
        t = f + self.phase
        if self.mode == "dj":
            p = pose_dj(t)
            if speaking:
                p["arm.R"] = -2.7 + 0.25 * math.sin(t * 0.5)
            return p
        return pose_talk(t) if speaking else pose_type(t)


def exec_routes(data):
    """Jalur Trade Executor dari meja ke kursi Meeting Room."""
    ex = data["executors"]
    west = [a["id"] for a in ex if a["camp"] == "bull"]
    east = [a["id"] for a in ex if a["camp"] == "bear"]
    for a in ex:
        if a["camp"] == "neutral":
            (west if len(west) <= len(east) else east).append(a["id"])
    head = next(a["id"] for a in ex if a["camp"] == "moderator")
    door_in = Vector((MEETING[0] + 0.6, MEET_DOOR_Y))
    seats = {head: (HEAD_SEAT, 0.0, [door_in, Vector((5.4, 0.25)), Vector((9.6, 0.25)), Vector((9.6, HEAD_SEAT.y))])}
    for aid, y in zip(west, SIDE_YS):
        seats[aid] = (Vector((WEST_SEAT_X, y)), math.pi / 2, [door_in, Vector((5.4, MEET_DOOR_Y)), Vector((5.4, y))])
    for aid, y in zip(east, SIDE_YS):
        seats[aid] = (Vector((EAST_SEAT_X, y)), -math.pi / 2,
                      [door_in, Vector((5.4, 0.25)), Vector((9.6, 0.25)), Vector((9.6, y))])
    routes = {}
    for i, a in enumerate(ex):
        desk = Vector((EXEC_COLS[i % 3], EXEC_ROWS[i // 3]))
        aisle = desk.y + 1.25
        path = [Vector((desk.x + 1.4, desk.y)), Vector((desk.x + 1.4, aisle)), Vector((WALK_X, aisle)),
                Vector((WALK_X, MEET_DOOR_Y))] + seats[a["id"]][2]
        routes[a["id"]] = (desk, path, seats[a["id"]][0], seats[a["id"]][1])
    return routes


# ---------------------------------------------------------- kamera & view

VIEWS = (
    # nama, target, ortho, sembunyikan
    ("CAM_Overview", (4.0, -4.0, 2.0), 58.0, ["Roof"]),
    ("CAM_Building", (-1.0, 0.3, 3.0), 33.0, ["Roof"]),
    ("CAM_Floor1", (-0.5, 0.0, 1.0), 27.0, ["Floor_2", "Roof", "Facade_1"]),
    ("CAM_TradingFloor", (-4.3, 1.4, 1.0), 15.5, ["Floor_2", "Roof", "Facade_1"]),
    ("CAM_MeetingRoom", (7.5, 2.9, 1.2), 9.5, ["Floor_2", "Roof", "Facade_1"]),
    ("CAM_Pantry", (7.5, -3.8, 1.0), 8.5, ["Floor_2", "Roof", "Facade_1"]),
    ("CAM_Floor2", (-0.5, 0.0, FH + 1.0), 27.0, ["Roof", "Facade_2"]),
    ("CAM_LeadRooms", (-5.25, 0.0, FH + 1.0), 15.5, ["Roof", "Facade_2"]),
    ("CAM_OwnerRoom", (7.2, 2.6, FH + 1.0), 11.0, ["Roof", "Facade_2"]),
    ("CAM_GameRoom", (7.5, -4.0, FH + 1.0), 8.5, ["Roof", "Facade_2"]),
)


def build_cameras(scene, rooms, cam_col):
    views = {}
    specs = list(VIEWS)
    for aid, (seat, (rx0, ry0, rx1, ry1)) in rooms.items():
        specs.append((f"CAM_Lead_{aid}", ((rx0 + rx1) / 2, (ry0 + ry1) / 2, FH + 1.0), 6.0, ["Roof", "Facade_2"]))
    for name, target, ortho, hide in specs:
        cam = iso_camera(scene, name, target, ortho)
        cam["base_ortho"] = ortho
        scene.collection.objects.unlink(cam)
        cam_col.objects.link(cam)
        views[name] = {"camera": name, "hide": hide}
    # kamera eksterior perspektif (atap tampil)
    cd = bpy.data.cameras.new("CAM_Exterior")
    cd.lens = 32
    cd.clip_end = 400
    cam = bpy.data.objects.new("CAM_Exterior", cd)
    cam_col.objects.link(cam)
    target = Vector((2.0, -1.0, 3.0))
    cam.location = Vector((34.0, -40.0, 17.0))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    views["CAM_Exterior"] = {"camera": "CAM_Exterior", "hide": []}
    scene["qb_views"] = json.dumps(views)
    scene["qb_toggle_collections"] = json.dumps(list(TOGGLES))
    return views


def apply_view(scene, views, name):
    v = views[name]
    scene.camera = bpy.data.objects[v["camera"]]
    for cname in TOGGLES:
        c = bpy.data.collections.get(cname)
        if c:
            hidden = cname in v["hide"]
            c.hide_render = hidden
            c.hide_viewport = hidden


# ---------------------------------------------------------------- lineup

def build_lineup_hq(data, rigs, args):
    """Scene terpisah: Owner, 9 Lead, 9 Trade Executor berjajar dengan papan nama."""
    sc = bpy.data.scenes.new("Character_Lineup")
    col = bpy.data.collections.new("Lineup")
    sc.collection.children.link(col)
    P = palette()
    people = [data["owner"]] + data["leads"] + data["executors"]
    n, gap = len(people), 1.25
    width = (n - 1) * gap + 2.4
    box("Lineup_Floor", (width + 2, 5, 0.1), (0, 1.0, -0.1), mat("#E3E7EC", 0.8), col, bevel=0)
    box("Lineup_Wall", (width + 2, 0.1, 5), (0, 3.0, -0.1), mat("#DCE2E9", 0.8), col, bevel=0)
    for i, a in enumerate(people):
        x = (i - (n - 1) / 2) * gap
        r = rigs[a["id"]].copy()
        r.animation_data_clear()
        r.location, r.rotation_euler = (x, 0, 0), (0, 0, 0)
        col.objects.link(r)
        body = bpy.data.objects[f"{a['id']}_body"].copy()
        body.parent = r
        body.modifiers["Armature"].object = r
        col.objects.link(body)
        pose = pose_stand(0)
        if a is data["owner"]:
            pose["arm.R"], pose["arm.L"] = -2.7, -0.2      # melambai
        else:
            pose["arm.R"], pose["arm.L"] = (-0.2, 0.15) if i % 2 else (0.15, -0.2)
        apply_pose(r, pose)
        plate = "#4A3216" if a is data["owner"] else ("#1E2A3A" if a in data["leads"] else "#2B2F36")
        box(f"Lineup_{a['id']}_plaque", (1.12, 0.12, 0.42), (x, -0.6, 0), mat(plate, 0.5), col, bevel=0.02)
        text(f"Lineup_{a['id']}", a["id"], (x, -0.67, 0.2), 0.15, mat(label_color_safe(a["look"]), 0.4, emit=1.5),
             col, yaw_deg=0)
        text(f"Lineup_{a['id']}_role", a["role"].upper(), (x, -0.67, 0.07), 0.07, P["white"], col, yaw_deg=0)
    for label, i0, i1 in (("FOUNDER", 0, 0), ("LEAD AGENTS", 1, 9), ("TRADE EXECUTORS", 10, 18)):
        x = ((i0 + i1) / 2 - (n - 1) / 2) * gap
        text(f"Lineup_group_{label}", label, (x, 2.9, 2.35), 0.24, mat("#1E2A3A", 0.5), col, yaw_deg=0)
    text("Lineup_Title", f"{data['office']['name']} HQ", (0, 2.9, 2.85), 0.42, mat("#1E2A3A", 0.5), col, yaw_deg=0)
    iso_camera(sc, "Lineup_Camera", (0, 0, 1.55), width + 0.6, yaw=0.0, pitch=80.0)
    lights_and_world(sc, args, strength=1.0)
    sc.render.resolution_y = int(sc.render.resolution_x * 0.3)
    return sc


# ---------------------------------------------------------------- ekspor

def export_glb(path):
    """Ekspor GLB untuk web viewer: teks diubah ke mesh, objek dikelompokkan per lantai."""
    scene = bpy.context.scene
    for c in TOGGLES:
        col = bpy.data.collections.get(c)
        if col:
            col.hide_viewport = False
            col.hide_render = False
    view_layer = bpy.context.view_layer
    fonts = [o for o in scene.objects if o.type == "FONT"]
    for o in fonts:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(bpy.context.evaluated_depsgraph_get()))
        new = bpy.data.objects.new(o.name + "_m", me)
        for c in o.users_collection:
            c.objects.link(new)
        new.parent = o.parent
        new.parent_type = o.parent_type
        new.parent_bone = o.parent_bone
        new.matrix_parent_inverse = o.matrix_parent_inverse.copy()
        new.location, new.rotation_euler, new.scale = o.location.copy(), o.rotation_euler.copy(), o.scale.copy()
        bpy.data.objects.remove(o, do_unlink=True)
    # grup per koleksi utama supaya bisa disembunyikan di viewer
    groups = {}
    for gname in ("Facade_1", "Facade_2", "Exterior", "Floor_1", "Floor_2", "Roof"):
        col = bpy.data.collections.get(gname)
        if not col:
            continue
        grp = bpy.data.objects.new(f"GRP_{gname}", None)
        scene.collection.objects.link(grp)
        groups[gname] = grp
        for o in col.all_objects:
            if o.parent is None and o.type != "LIGHT":
                o.parent = grp
    for n in ("1", "2"):
        if f"Facade_{n}" in groups and f"Floor_{n}" in groups:
            groups[f"Facade_{n}"].parent = groups[f"Floor_{n}"]
    view_layer.update()
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(path), export_format="GLB", export_apply=False,
        export_animations=True, export_animation_mode="SCENE", export_cameras=False,
        export_lights=False, export_yup=True, export_texcoords=True, export_normals=True,
        export_frame_step=2, export_force_sampling=True, export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14, export_draco_normal_quantization=8,
        export_draco_texcoord_quantization=10)


# ------------------------------------------------------------------- main

def main():
    args = parse_args()
    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)
    clear_all()
    scene = bpy.context.scene
    scene.name = "QUANTBOT_HQ"
    P = palette()
    M = {k: image_mat(f"Floor_{k}", planks_image(k), 0.65) for k in WOODS}
    M.update({
        "grass": image_mat("Grass", noise_image("TEX_grass", ["#5DA130", "#4E8F27", "#6DB33F", "#437D22"],
                                                weights=[4, 3, 2, 1]), 0.9),
        "asphalt": image_mat("Asphalt", noise_image("TEX_asphalt", ["#3A3D42", "#34373B", "#43464C"], seed=5), 0.85),
        "paver": image_mat("Paver", gen_image("TEX_paver", 16, 16, lambda x, y: "#A9A397" if x % 8 == 0 or y % 8 == 0
                                              else ("#CFC9BC" if _hash(x // 8, y // 8) % 2 else "#C2BCAF")), 0.8),
        "sky": mat("#9FD3F2", 0.1, emit=0.6),
        "chart": [image_mat(f"Chart{k}", chart_image(f"TEX_chart{k}", 11 + k * 7), 0.3, emit=1.6) for k in range(3)],
        "chart_big": image_mat("ChartBig", chart_image("TEX_chart_big", 99, 96, 32), 0.3, emit=1.8),
        "bloomberg": image_mat("Bloomberg", bloomberg_image(), 0.3, emit=1.6),
        "slide": image_mat("Slide", slide_image(), 0.3, emit=1.4),
        "game": [image_mat(f"Game{k}", game_image(k + 1), 0.3, emit=1.6) for k in range(3)],
        "led": image_mat("LED", led_image(), 0.3, emit=2.5),
    })

    ext = collection("Exterior")
    f1 = collection("Floor_1")
    f2 = collection("Floor_2")
    roof = collection("Roof")
    cams = collection("Cameras")
    build_exterior(P, M, ext)
    build_shell(P, M, f1, f2, roof)
    build_trading_floor(data, P, M, collection("F1_TradingFloor", f1), None)
    build_meeting_room(data, P, M, collection("F1_MeetingRoom", f1))
    build_pantry(P, M, collection("F1_Pantry", f1))
    rooms = lead_rooms(data, P, M, collection("F2_LeadRooms", f2))
    build_hall(P, M, collection("F2_Lobby", f2))
    dj_spot = build_owner_room(data, P, M, collection("F2_OwnerRoom", f2))
    build_game_room(P, M, collection("F2_GameRoom", f2))

    # karakter
    f1_agents, f2_agents = collection("F1_Agents", f1), collection("F2_Agents", f2)
    rigs = {}
    for a in data["executors"]:
        rigs[a["id"]] = build_rig(a, f1_agents)
    for a in data["leads"]:
        rigs[a["id"]] = build_rig(a, f2_agents)
    owner = data["owner"]
    rigs[owner["id"]] = build_rig(owner, f2_agents)
    make_library_actions(rigs[data["executors"][0]["id"]])

    # meeting room: kursi per agen
    routes = exec_routes(data)
    looks = {a["id"]: a["look"] for a in data["executors"] + data["leads"] + [owner]}
    for aid, (_, _, seat, yaw) in routes.items():
        build_chair(f"MR_Chair_{aid}", seat, math.degrees(yaw), looks[aid]["top"], P, collection("F1_MeetingRoom", f1))

    # rencana gerak
    chatter_end = max(c["frame"] for c in data["desk_chatter"]) + 50
    order = sorted(routes, key=lambda k: polyline([routes[k][0]] + routes[k][1] + [routes[k][2]])[1])
    f1_plans = {}
    for k, aid in enumerate(order):
        desk, path, seat, yaw = routes[aid]
        f1_plans[aid] = Plan(aid, desk, path, seat, yaw, chatter_end + k * 10)
    f2_plans = {aid: SeatPlan(aid, seat, FH) for aid, (seat, _) in rooms.items()}
    f2_plans[owner["id"]] = SeatPlan(owner["id"], dj_spot, FH, mode="dj")

    f1_speech = [(c["agent"], c["frame"], c["frame"] + 46, c["text"]) for c in data["desk_chatter"]]
    f = max(p.f_seated for p in f1_plans.values()) + 16
    debate_start = f
    for line in data["debate"]:
        f1_speech.append((line["agent"], f, f + MSG_F, line["text"]))
        f += MSG_F + MSG_GAP
    f2_speech = [(c["agent"], c["frame"], c["frame"] + 56, c["text"]) for c in data["floor2_chatter"]]
    frame_end = max(f, max(s[2] for s in f2_speech)) + 24

    views = build_cameras(scene, rooms, cams)
    main_cam = bpy.data.objects["CAM_Building"]
    lights_and_world(scene, args)
    scene.frame_start, scene.frame_end = 1, frame_end
    scene.render.fps = data["office"].get("fps", 24)

    for group, speech, col in ((f1_plans, f1_speech, collection("F1_Bubbles", f1)),
                               (f2_plans, f2_speech, collection("F2_Bubbles", f2))):
        for n, (aid, f0, f1_, msg) in enumerate(speech):
            root = make_bubble(f"Bubble_{aid}_{n:02d}", aid, msg, looks[aid]["top"], col, main_cam)
            attach_bubble(root, rigs[aid], f0, f1_)
        for aid, plan in group.items():
            bake(rigs[aid], plan, group, speech, frame_end)

    # panel viewer di sidebar (didaftarkan sekarang dan otomatis saat file dibuka)
    panel_path = os.path.join(HERE, "quantbot_viewer_panel.py")
    if os.path.exists(panel_path):
        txt = bpy.data.texts.load(panel_path)
        txt.use_module = True
        ns = {"__name__": "quantbot_viewer_panel"}
        exec(compile(txt.as_string(), panel_path, "exec"), ns)
        ns["register"]()

    print(f"[hq] {len(rigs)} karakter, frame 1-{frame_end}, debat mulai f{debate_start}")
    for aid in order:
        p = f1_plans[aid]
        print(f"  {aid:6s} berdiri f{p.f_stand}, tiba f{p.f_arrive}, duduk f{p.f_seated}")

    if args.schedule:
        lead_rooms_view = {aid: f"CAM_Lead_{aid}" for aid in rooms}
        sched = {
            "fps": scene.render.fps, "frame_end": frame_end, "floor_height": FH,
            "views": [{"name": n, "target": list(t), "ortho": o, "hide": h} for n, t, o, h in VIEWS] +
                     [{"name": f"CAM_Lead_{aid}", "target": [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2, FH + 1.0],
                       "ortho": 6.0, "hide": ["Roof", "Facade_2"]} for aid, (_, r) in rooms.items()],
            "agents": [{"id": a["id"], "role": a["role"], "floor": 1, "color": a["look"]["top"]} for a in data["executors"]] +
                      [{"id": a["id"], "role": a["role"], "floor": 2, "color": a["look"]["top"], "view": lead_rooms_view[a["id"]]}
                       for a in data["leads"]] +
                      [{"id": owner["id"], "role": owner["role"], "floor": 2, "color": owner["look"]["top"], "view": "CAM_OwnerRoom"}],
            "speech": sorted([{"agent": s_[0], "f0": s_[1], "f1": s_[2], "text": s_[3], "floor": 1} for s_ in f1_speech] +
                             [{"agent": s_[0], "f0": s_[1], "f1": s_[2], "text": s_[3], "floor": 2} for s_ in f2_speech],
                             key=lambda d: d["f0"]),
            "debate_start": debate_start,
        }
        with open(args.schedule, "w", encoding="utf-8") as fh:
            json.dump(sched, fh, ensure_ascii=False, indent=1)
        print(f"[hq] jadwal: {args.schedule}")

    apply_view(scene, views, "CAM_Building")
    scene.frame_set(1)
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save), compress=True)
        print(f"[hq] disimpan: {args.save}")
    for spec in args.render:
        cam_name, path, frame = spec.split(":")
        apply_view(scene, views, cam_name)
        scene.frame_set(int(frame))
        scene.render.filepath = os.path.abspath(path)
        bpy.ops.render.render(write_still=True)
        print(f"[hq] render {cam_name} f{frame}: {path}")
    if args.render_lineup:
        lineup = build_lineup_hq(data, rigs, args)
        lineup.render.filepath = os.path.abspath(args.render_lineup)
        bpy.ops.render.render(write_still=True, scene=lineup.name)
        bpy.data.scenes.remove(lineup)
        print(f"[hq] lineup: {args.render_lineup}")
    if args.glb:
        export_glb(args.glb)
        print(f"[hq] glb: {args.glb} ({os.path.getsize(args.glb) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
