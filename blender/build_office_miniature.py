"""
Miniatur 3D Office Asset Management untuk Blender (4.2+ / 5.x).

Membangun diorama kantor (cutaway) dari data aset di office_assets.json:
setiap aset menjadi Empty bernama ID aset dengan custom properties
(nama, status, pemilik, tanggal beli, nilai) + model low-poly, pin status
berwarna, dan label ID.

Pemakaian:
  GUI    : buka Blender > Scripting > Open file ini > Run Script
  CLI    : blender --background --python build_office_miniature.py -- \
             [--data office_assets.json] [--save office.blend] \
             [--render preview.png] [--samples 64] [--res 1920x1080]
"""

import argparse
import json
import math
import os
import sys
from collections import Counter

import bmesh
import bpy
from mathutils import Vector

CAM_YAW = 45.0     # kamera melihat dari depan-kanan (+X, -Y)
CAM_PITCH = 60.0   # 60 derajat dari vertikal = 30 derajat menukik


# ---------------------------------------------------------------- utilitas

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    here = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else ""
    p = argparse.ArgumentParser(prog="build_office_miniature")
    p.add_argument("--data", default=os.path.join(here, "office_assets.json"))
    p.add_argument("--save", help="simpan hasil ke file .blend")
    p.add_argument("--render", help="render preview ke file PNG")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--res", default="1920x1080")
    return p.parse_args(argv)


def hex_rgba(h, a=1.0):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, a)


_MATS = {}


def mat(hex_color, rough=0.55, metal=0.0, emit=0.0, glass=False):
    key = (hex_color, rough, metal, emit, glass)
    if key in _MATS:
        return _MATS[key]
    m = bpy.data.materials.new(f"M_{hex_color.lstrip('#')}_{len(_MATS)}")
    if bpy.app.version < (5, 0):
        m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = hex_rgba(hex_color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(hex_color)
        bsdf.inputs["Emission Strength"].default_value = emit
    if glass:
        bsdf.inputs["Transmission Weight"].default_value = 1.0
        bsdf.inputs["IOR"].default_value = 1.45
    m.diffuse_color = hex_rgba(hex_color)  # warna di viewport Solid
    _MATS[key] = m
    return m


def collection(name, parent=None):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    parent = parent or bpy.context.scene.collection
    if col.name not in parent.children:
        parent.children.link(col)
    return col


def _finish(name, bm, material, col, parent, loc, rot, smooth=False, bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = rot
    ob.parent = parent
    if bevel:
        mod = ob.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return ob


def box(name, size, loc, material, col, parent=None, rot=(0, 0, 0), bevel=None):
    """Kotak dengan `loc` = titik tengah bawah (z = alas)."""
    sx, sy, sz = size
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    if bevel is None:
        bevel = min(0.015, min(size) * 0.2)
    return _finish(name, bm, material, col, parent,
                   (loc[0], loc[1], loc[2] + sz / 2), rot, bevel=bevel)


def cyl(name, r, h, loc, material, col, parent=None, r2=None, segs=24, rot=(0, 0, 0)):
    """Silinder/kerucut dengan `loc` = titik tengah bawah."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    return _finish(name, bm, material, col, parent,
                   (loc[0], loc[1], loc[2] + h / 2), rot, smooth=True)


def sphere(name, r, loc, material, col, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=20, v_segments=10, radius=r)
    return _finish(name, bm, material, col, parent, loc, (0, 0, 0), smooth=True)


def text(name, body, loc, size, material, col, parent=None, standing=True, align="CENTER",
         yaw_deg=CAM_YAW):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = align
    cu.align_y = "BOTTOM" if standing else "CENTER"
    cu.extrude = 0.004
    cu.materials.append(material)
    ob = bpy.data.objects.new(name, cu)
    col.objects.link(ob)
    ob.parent = parent
    ob.location = loc
    ob.rotation_euler = (math.radians(90) if standing else 0, 0, math.radians(yaw_deg))
    return ob


def empty(name, loc, rot_deg, col, parent=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "PLAIN_AXES"
    ob.empty_display_size = 0.25
    col.objects.link(ob)
    ob.location = loc
    ob.rotation_euler = (0, 0, math.radians(rot_deg))
    ob.parent = parent
    return ob


# ------------------------------------------------------------- palet bahan

def palette():
    return {
        "wood": mat("#B08B62", 0.6),
        "wood_dark": mat("#6E5238", 0.6),
        "white": mat("#F2F2EE", 0.45),
        "grey": mat("#A7ADB3", 0.5),
        "dark": mat("#2B2F36", 0.45),
        "black": mat("#15171A", 0.35),
        "steel": mat("#8E949B", 0.3, metal=0.8),
        "rack": mat("#1E2228", 0.65, metal=0.4),
        "screen": mat("#2F6DB5", 0.15, emit=1.6),
        "led_g": mat("#39FF88", 0.3, emit=6.0),
        "led_b": mat("#4DB8FF", 0.3, emit=6.0),
        "fabric": mat("#34495E", 0.9),
        "red": mat("#C0392B", 0.4),
        "glass": mat("#DDEEFF", 0.03, glass=True),
        "wall": mat("#ECE8E1", 0.85),
        "base": mat("#3A3F47", 0.6),
        "label": mat("#1E2329", 0.5),
        "box": mat("#C9A66B", 0.8),
    }


# ----------------------------------------------------------- builder aset
# Koordinat lokal: depan aset menghadap -Y. Setiap builder mengembalikan
# tinggi (m) untuk menaruh pin status di atasnya.

def build_chair(P, col, parent, x, y, rot_deg):
    g = empty(f"{parent.name}_chair", (x, y, 0), rot_deg, col, parent)
    g.empty_display_size = 0.05
    cyl(f"{g.name}_base", 0.28, 0.05, (0, 0, 0.03), P["black"], col, g, segs=5)
    cyl(f"{g.name}_pole", 0.03, 0.38, (0, 0, 0.08), P["steel"], col, g)
    box(f"{g.name}_seat", (0.48, 0.46, 0.07), (0, 0, 0.44), P["fabric"], col, g)
    box(f"{g.name}_back", (0.46, 0.06, 0.5), (0, -0.24, 0.55), P["fabric"], col, g,
        rot=(math.radians(-8), 0, 0))


def build_workstation(P, col, g):
    box(f"{g.name}_top", (1.4, 0.7, 0.04), (0, 0, 0.71), P["wood"], col, g)
    for sx in (-0.66, 0.66):
        box(f"{g.name}_leg{sx:+.0f}", (0.05, 0.64, 0.71), (sx, 0, 0), P["steel"], col, g)
    box(f"{g.name}_modesty", (1.26, 0.02, 0.35), (0, 0.32, 0.33), P["grey"], col, g)
    # monitor
    box(f"{g.name}_mon_base", (0.22, 0.16, 0.015), (0, 0.18, 0.75), P["dark"], col, g)
    box(f"{g.name}_mon_neck", (0.04, 0.03, 0.17), (0, 0.2, 0.76), P["dark"], col, g)
    box(f"{g.name}_mon", (0.58, 0.03, 0.35), (0, 0.17, 0.9), P["black"], col, g)
    box(f"{g.name}_mon_scr", (0.55, 0.005, 0.32), (0, 0.153, 0.915), P["screen"], col, g, bevel=0)
    # perangkat input + CPU
    box(f"{g.name}_kbd", (0.42, 0.14, 0.02), (-0.05, -0.08, 0.75), P["dark"], col, g)
    box(f"{g.name}_mouse", (0.06, 0.1, 0.02), (0.25, -0.08, 0.75), P["dark"], col, g)
    box(f"{g.name}_cpu", (0.18, 0.42, 0.4), (0.48, 0.05, 0.0), P["dark"], col, g)
    box(f"{g.name}_cpu_led", (0.02, 0.005, 0.02), (0.48, -0.165, 0.34), P["led_b"], col, g, bevel=0)
    build_chair(P, col, g, 0, -0.58, 0)
    return 1.3


def build_laptop(P, col, g):
    z = 0.76  # di atas meja rapat
    box(f"{g.name}_base", (0.32, 0.22, 0.015), (0, 0, z), P["steel"], col, g)
    box(f"{g.name}_lid", (0.32, 0.012, 0.21), (0, 0.115, z + 0.01), P["steel"], col, g,
        rot=(math.radians(-15), 0, 0))
    box(f"{g.name}_scr", (0.29, 0.003, 0.18), (0, 0.105, z + 0.025), P["screen"], col, g,
        rot=(math.radians(-15), 0, 0), bevel=0)
    return 1.05


def build_meeting_table(P, col, g):
    box(f"{g.name}_top", (2.6, 1.1, 0.05), (0, 0, 0.71), P["wood_dark"], col, g)
    for sx in (-0.85, 0.85):
        box(f"{g.name}_ped{sx:+.0f}", (0.12, 0.6, 0.71), (sx, 0, 0), P["steel"], col, g)
    for i, x in enumerate((-0.8, 0.0, 0.8)):
        build_chair(P, col, g, x, -0.85, 0)
        build_chair(P, col, g, x, 0.85, 180)
    build_chair(P, col, g, -1.6, 0, -90)
    build_chair(P, col, g, 1.6, 0, 90)
    return 1.15


def build_display(P, col, g):
    for sx in (-0.45, 0.45):
        box(f"{g.name}_foot{sx:+.1f}", (0.08, 0.5, 0.03), (sx, 0, 0), P["dark"], col, g)
    box(f"{g.name}_post", (0.12, 0.06, 1.0), (0, 0.06, 0.03), P["dark"], col, g)
    box(f"{g.name}_tv", (1.46, 0.06, 0.84), (0, 0, 0.95), P["black"], col, g)
    box(f"{g.name}_scr", (1.4, 0.005, 0.78), (0, -0.032, 0.98), P["screen"], col, g, bevel=0)
    return 1.9


def build_server_rack(P, col, g):
    h = 2.0 if "42U" in g["name"] else 1.25
    box(f"{g.name}_body", (0.6, 1.0, h), (0, 0, 0), P["rack"], col, g)
    rows = int((h - 0.25) / 0.09)
    for i in range(rows):
        z = 0.12 + i * 0.09
        box(f"{g.name}_u{i}", (0.48, 0.02, 0.06), (0, -0.51, z), P["dark"], col, g, bevel=0)
        led = P["led_g"] if i % 3 else P["led_b"]
        box(f"{g.name}_led{i}", (0.03, 0.006, 0.012), (0.19, -0.522, z + 0.024), led, col, g, bevel=0)
    return h + 0.1


def build_ups(P, col, g):
    box(f"{g.name}_body", (0.45, 0.7, 0.9), (0, 0, 0), P["dark"], col, g)
    box(f"{g.name}_lcd", (0.16, 0.006, 0.07), (0, -0.352, 0.72), P["led_b"], col, g, bevel=0)
    return 1.0


def build_ac_unit(P, col, g):
    box(f"{g.name}_body", (0.7, 0.55, 1.9), (0, 0, 0), P["white"], col, g)
    for i in range(10):
        box(f"{g.name}_fin{i}", (0.6, 0.015, 0.02), (0, -0.28, 0.9 + i * 0.08), P["grey"], col, g, bevel=0)
    box(f"{g.name}_panel", (0.2, 0.006, 0.12), (0, -0.278, 0.6), P["led_b"], col, g, bevel=0)
    return 2.0


def build_printer(P, col, g):
    big = "imageRUNNER" in g["name"]
    s = 1.0 if big else 0.7
    if big:
        box(f"{g.name}_cab", (0.62, 0.62, 0.5), (0, 0, 0), P["grey"], col, g)
        z = 0.5
    else:
        box(f"{g.name}_stand", (0.7, 0.5, 0.72), (0, 0, 0), P["wood"], col, g)
        z = 0.72
    box(f"{g.name}_body", (0.6 * s, 0.6 * s, 0.38 * s), (0, 0, z), P["white"], col, g)
    box(f"{g.name}_scan", (0.56 * s, 0.5 * s, 0.1 * s), (0, 0.02, z + 0.38 * s), P["grey"], col, g)
    box(f"{g.name}_tray", (0.36 * s, 0.22 * s, 0.03), (0, -0.35 * s, z + 0.12 * s), P["white"], col, g)
    box(f"{g.name}_paper", (0.3 * s, 0.2 * s, 0.02), (0, -0.34 * s, z + 0.15 * s), P["white"], col, g, bevel=0)
    box(f"{g.name}_ui", (0.18 * s, 0.006, 0.07 * s), (0.15 * s, -0.305 * s, z + 0.26 * s),
        P["led_b"], col, g, bevel=0)
    return z + 0.6 * s


def build_cabinet(P, col, g):
    box(f"{g.name}_body", (0.47, 0.62, 1.32), (0, 0, 0), P["grey"], col, g)
    for i in range(4):
        z = 0.06 + i * 0.315
        box(f"{g.name}_drw{i}", (0.43, 0.01, 0.29), (0, -0.312, z), P["steel"], col, g, bevel=0.004)
        box(f"{g.name}_hdl{i}", (0.14, 0.02, 0.025), (0, -0.322, z + 0.22), P["dark"], col, g, bevel=0.004)
    return 1.45


def build_shelf(P, col, g):
    w, d, h = 1.0, 0.45, 1.8
    for sx in (-w / 2, w / 2):
        for sy in (-d / 2, d / 2):
            box(f"{g.name}_post", (0.035, 0.035, h), (sx, sy, 0), P["steel"], col, g, bevel=0.004)
    for i in range(5):
        z = 0.08 + i * 0.42
        box(f"{g.name}_board{i}", (w, d, 0.025), (0, 0, z), P["grey"], col, g, bevel=0.003)
        if i < 4:
            for j, bx in enumerate((-0.3, 0.05, 0.32)):
                bh = 0.18 + 0.06 * ((i + j) % 3)
                box(f"{g.name}_box{i}{j}", (0.26, 0.3, bh), (bx, 0, z + 0.025), P["box"], col, g)
    return 1.95


def build_access_point(P, col, g):
    cyl(f"{g.name}_foot", 0.16, 0.03, (0, 0, 0), P["dark"], col, g)
    cyl(f"{g.name}_pole", 0.02, 2.15, (0, 0, 0.03), P["steel"], col, g)
    cyl(f"{g.name}_disc", 0.11, 0.04, (0, 0, 2.18), P["white"], col, g, r2=0.09, segs=32)
    cyl(f"{g.name}_ring", 0.03, 0.005, (0, 0, 2.22), P["led_b"], col, g)
    return 2.35


def build_cctv(P, col, g):
    z = 2.35
    box(f"{g.name}_plate", (0.14, 0.02, 0.14), (0, 0.13, z - 0.07), P["white"], col, g)
    box(f"{g.name}_arm", (0.04, 0.14, 0.04), (0, 0.06, z - 0.02), P["white"], col, g)
    sphere(f"{g.name}_dome", 0.065, (0, 0, z - 0.04), P["black"], col, g)
    return z + 0.1


def build_fire_extinguisher(P, col, g):
    cyl(f"{g.name}_tank", 0.08, 0.5, (0, 0, 0), P["red"], col, g)
    cyl(f"{g.name}_neck", 0.03, 0.06, (0, 0, 0.5), P["dark"], col, g)
    box(f"{g.name}_handle", (0.12, 0.03, 0.02), (0.02, 0, 0.56), P["dark"], col, g)
    return 0.7


BUILDERS = {
    "workstation": build_workstation,
    "laptop": build_laptop,
    "meeting_table": build_meeting_table,
    "display": build_display,
    "server_rack": build_server_rack,
    "ups": build_ups,
    "ac_unit": build_ac_unit,
    "printer": build_printer,
    "cabinet": build_cabinet,
    "shelf": build_shelf,
    "access_point": build_access_point,
    "cctv": build_cctv,
    "fire_extinguisher": build_fire_extinguisher,
}


# ------------------------------------------------------------ kantor/shell

def build_shell(data, P):
    o = data["office"]
    W, D, H = o["width"], o["depth"], o["wall_height"]
    col = collection("Office_Shell")
    t = 0.12
    # alas diorama, bibir depan dibuat lebar untuk judul & legenda
    box("Diorama_Base", (W + 1.6, D + 1.8, 0.35), (0.4, -0.5, -0.35), P["base"], col, bevel=0.04)
    box("Floor", (W, D, 0.02), (0, 0, -0.02), P["white"], col, bevel=0)
    box("Wall_Back", (W + t, t, H), (-t / 2, D / 2 + t / 2, 0), P["wall"], col, bevel=0.01)
    box("Wall_Left", (t, D, H), (-W / 2 - t / 2, 0, 0), P["wall"], col, bevel=0.01)
    box("Skirting_Back", (W, 0.02, 0.08), (0, D / 2 - 0.01, 0), P["wood_dark"], col, bevel=0)
    box("Skirting_Left", (0.02, D, 0.08), (-W / 2 + 0.01, 0, 0), P["wood_dark"], col, bevel=0)
    # jendela di dinding belakang (area kerja & storage)
    for i, x in enumerate((-4.5, -2.0)):
        box(f"Window_{i}", (1.6, 0.02, 1.1), (x, D / 2 - 0.005, 1.0), P["glass"], col, bevel=0)
        box(f"Window_{i}_sill", (1.7, 0.1, 0.04), (x, D / 2 - 0.05, 0.98), P["white"], col, bevel=0)

    for i, pt in enumerate(data.get("partitions", [])):
        (x1, y1), (x2, y2) = pt["from"], pt["to"]
        length = math.hypot(x2 - x1, y2 - y1)
        ang = math.atan2(y2 - y1, x2 - x1)
        mid = ((x1 + x2) / 2, (y1 + y2) / 2, 0)
        if pt["type"] == "glass":
            box(f"Partition_{i}_glass", (length, 0.03, 2.2), mid, P["glass"], col,
                rot=(0, 0, ang), bevel=0)
            box(f"Partition_{i}_frame", (length, 0.06, 0.06), (mid[0], mid[1], 2.2), P["dark"], col,
                rot=(0, 0, ang), bevel=0)
            box(f"Partition_{i}_rail", (length, 0.06, 0.06), mid, P["dark"], col,
                rot=(0, 0, ang), bevel=0)
        else:
            # dinding internal dipotong rendah (gaya cutaway) agar isi ruangan terlihat
            box(f"Partition_{i}_wall", (length, 0.1, 1.0), mid, P["wall"], col,
                rot=(0, 0, ang), bevel=0.01)


def build_zones(data, P):
    col = collection("Zones")
    for z in data["zones"]:
        x1, y1, x2, y2 = z["rect"]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        box(f"Zone_{z['id']}_floor", (x2 - x1 - 0.02, y2 - y1 - 0.02, 0.01), (cx, cy, 0.0),
            mat(z["floor"], 0.8), col, bevel=0)
        lx, ly = z.get("label_pos", (x1 + 0.15, y1 + 0.22))
        text(f"Zone_{z['id']}_label", z["name"].upper(), (lx, ly, 0.012), 0.2,
             P["label"], col, standing=False, align="LEFT", yaw_deg=0)


def build_assets(data, P):
    colors = data["status_colors"]
    root = collection("Assets")
    markers = collection("Status_Markers")
    zone_cols = {z["id"]: collection(f"Assets_{z['id']}", root) for z in data["zones"]}
    show_labels = data["office"].get("show_labels", True)
    stats = Counter()

    for a in data["assets"]:
        builder = BUILDERS.get(a["type"])
        if builder is None:
            print(f"[skip] {a['id']}: tipe '{a['type']}' belum didukung")
            continue
        col = zone_cols.get(a["zone"], root)
        g = empty(a["id"], (a["pos"][0], a["pos"][1], 0), a.get("rot", 0), col)
        for k in ("name", "type", "zone", "status", "owner", "purchase", "value_idr"):
            g[k] = a.get(k, "")
        height = builder(P, col, g)

        # pin status: kerucut terbalik + bola bercahaya
        status = a["status"]
        c = mat(colors.get(status, "#FFFFFF"), 0.3, emit=2.5)
        pin = empty(f"{a['id']}_pin", (0, 0, height + 0.05), 0, markers, g)
        pin.rotation_euler.z = -g.rotation_euler.z
        pin.empty_display_size = 0.05
        cyl(f"{a['id']}_pin_tip", 0.0, 0.16, (0, 0, 0), c, markers, pin, r2=0.055, segs=16)
        sphere(f"{a['id']}_pin_head", 0.075, (0, 0, 0.22), c, markers, pin)
        if show_labels:
            text(f"{a['id']}_label", a["id"], (0, 0, 0.33), 0.13, P["label"], markers, pin)
        stats[status] += 1

    return stats


def build_legend(data, P, stats):
    """Judul + legenda status tercetak di bibir depan alas, sejajar tepi."""
    col = collection("Legend")
    o = data["office"]
    W, D = o["width"], o["depth"]
    x0, y_title, y_row = -W / 2 + 0.1, -D / 2 - 0.45, -D / 2 - 1.0
    title = f"{o['name'].upper()}  /  {sum(stats.values())} ASET"
    text("Legend_Title", title, (x0, y_title, 0.005), 0.3, P["white"], col,
         standing=False, align="LEFT", yaw_deg=0)
    for i, (status, hexc) in enumerate(data["status_colors"].items()):
        x = x0 + 0.1 + i * 2.7
        sphere(f"Legend_{status}_dot", 0.1, (x, y_row, 0.1), mat(hexc, 0.3, emit=2.5), col)
        text(f"Legend_{status}_txt", f"{status.upper()}  {stats.get(status, 0)}",
             (x + 0.2, y_row, 0.005), 0.2, P["white"], col,
             standing=False, align="LEFT", yaw_deg=0)


# -------------------------------------------------------- kamera & cahaya

def setup_scene(data, args):
    scene = bpy.context.scene
    o = data["office"]

    cam_data = bpy.data.cameras.new("Iso_Camera")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(o["width"], o["depth"]) * 1.45
    cam = bpy.data.objects.new("Iso_Camera", cam_data)
    scene.collection.objects.link(cam)
    pitch, yaw = math.radians(CAM_PITCH), math.radians(CAM_YAW)
    view = Vector((-math.sin(yaw) * math.sin(pitch), math.cos(yaw) * math.sin(pitch), -math.cos(pitch)))
    target = Vector((0.3, -0.4, 0.6))
    cam.location = target - view * 40
    cam.rotation_euler = (pitch, 0, yaw)
    cam_data.clip_end = 200
    scene.camera = cam

    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 3.5
    sun_data.angle = math.radians(8)
    sun = bpy.data.objects.new("Sun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(40), math.radians(10), math.radians(20))

    fill_data = bpy.data.lights.new("Fill", "AREA")
    fill_data.energy = 1500
    fill_data.size = 10
    fill = bpy.data.objects.new("Fill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (6, -8, 9)
    fill.rotation_euler = (math.radians(45), 0, math.radians(35))

    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    if bpy.app.version < (5, 0):
        world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = hex_rgba("#D7DCE2")
    bg.inputs["Strength"].default_value = 0.8

    rx, ry = (int(v) for v in args.res.lower().split("x"))
    scene.render.resolution_x, scene.render.resolution_y = rx, ry
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.curves,
                  bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            block.remove(item)
    _MATS.clear()


def main():
    args = parse_args()
    data_path = args.data
    if not os.path.exists(data_path):
        data_path = bpy.path.abspath("//office_assets.json")
    with open(data_path, encoding="utf-8") as f:
        data = json.load(f)

    clear_scene()
    P = palette()
    build_shell(data, P)
    build_zones(data, P)
    stats = build_assets(data, P)
    build_legend(data, P, stats)
    setup_scene(data, args)

    total_value = sum(a.get("value_idr", 0) for a in data["assets"])
    scene = bpy.context.scene
    scene["asset_total"] = sum(stats.values())
    scene["asset_value_idr"] = total_value
    for status, n in stats.items():
        scene[f"asset_{status}"] = n
    print(f"[office] {sum(stats.values())} aset dibangun: {dict(stats)}")
    print(f"[office] total nilai aset: Rp {total_value:,.0f}".replace(",", "."))

    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save), compress=True)
        print(f"[office] disimpan: {args.save}")
    if args.render:
        scene.render.filepath = os.path.abspath(args.render)
        bpy.ops.render.render(write_still=True)
        print(f"[office] render: {args.render}")


if __name__ == "__main__":
    main()
