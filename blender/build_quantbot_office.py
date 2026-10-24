"""
QUANTBOT - kantor 9 agen trading AI bergaya Minecraft untuk Blender 4.2+ / 5.x.

Isi scene:
  - 9 karakter full body blocky (proporsi skin Minecraft), masing-masing satu
    mesh + armature (root, body, head, arm.L/R, leg.L/R) siap jalan & duduk.
  - 9 meja kerja dengan nameplate, kursi, dan monitor chart.
  - MEETING ROOM untuk debat: meja panjang, kubu BULL vs BEAR, layar chart.
  - Chat bubble melayang yang muncul (pop) saat agen berbicara, selalu
    menghadap kamera.
  - Animasi demo: agen mengetik di meja -> ATLAS memanggil rapat -> semua
    berjalan ke Meeting Room -> duduk -> debat bergiliran.
  - Action siap pakai (fake user): QB_Idle, QB_Walk, QB_Sit_Down,
    QB_Sit_Typing, QB_Sit_Talk, QB_Sit_Listen.
  - Scene kedua "Character_Lineup" berisi 9 karakter berjajar.

Pemakaian:
  GUI : Scripting > Open file ini > Run Script (quantbot_agents.json dan
        build_office_miniature.py harus satu folder).
  CLI : blender --background --python build_quantbot_office.py -- \
          [--save quantbot_office.blend] [--render office.png --frame 36] \
          [--render-lineup lineup.png] [--samples 48] [--res 1920x1200]
"""

import argparse
import json
import math
import os
import sys
import textwrap

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else bpy.path.abspath("//")
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from build_office_miniature import (  # noqa: E402  (helper bersama)
    _MATS, box, collection, cyl, empty, hex_rgba, mat, text,
)

PX = 0.056            # 1 piksel skin Minecraft = 5.6 cm -> tinggi karakter 1.79 m
SEAT_H = 0.45         # tinggi dudukan kursi
SIT_DROP = SEAT_H + 2 * PX - 12 * PX   # turunnya root saat duduk (paha di atas kursi)
WALK_SPEED = 0.09     # meter per frame (~2.2 m/s @ 24 fps)
STRIDE_F = 16         # frame per siklus langkah
STAND_F, TURN_F, SIT_F = 12, 8, 12
MSG_F, MSG_GAP = 60, 6
KEY_STEP = 2

W, D, WALL_H = 18.0, 10.0, 3.0           # kantor: x -9..9, y -5..5
DESK_COLS = (-7.0, -4.5, -2.0)
DESK_ROWS = (-2.4, 0.4, 3.2)             # posisi kursi (y)
CORRIDOR_X = -0.1
MEET_X0 = 0.8                            # dinding kaca Meeting Room
DOOR_Y = -2.9
TABLE_C, TABLE_SIZE = Vector((5.2, 0.1)), (1.5, 5.4)
SIDE_SEATS_Y = (-2.0, -0.6, 0.8, 2.2)
WEST_X, EAST_X = 4.1, 6.3
HEAD_SEAT = Vector((5.2, 3.35))


# ------------------------------------------------------------------ util

def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="build_quantbot_office")
    p.add_argument("--data", default=os.path.join(HERE, "quantbot_agents.json"))
    p.add_argument("--save")
    p.add_argument("--render", action="append", default=[],
                   help="path PNG; boleh diulang, dipasangkan dengan --frame")
    p.add_argument("--frame", type=int, action="append", default=[])
    p.add_argument("--render-lineup")
    p.add_argument("--samples", type=int, default=48)
    p.add_argument("--res", default="1920x1200")
    return p.parse_args(argv)


def yaw_of(d):
    """Yaw agar karakter (depan = -Y) menghadap arah d."""
    return math.atan2(d.x, -d.y)


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def smooth(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def lerp_pose(a, b, u):
    return {k: a.get(k, 0.0) + (b.get(k, 0.0) - a.get(k, 0.0)) * u for k in set(a) | set(b)}


def label_color(look):
    """Warna nama agen yang tetap terbaca di latar gelap."""
    for key in ("top", "accent"):
        r, g, b, _ = hex_rgba(look[key])
        if 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.08:
            return look[key]
    return "#FFFFFF"


def clear_all():
    for sc in list(bpy.data.scenes)[1:]:
        bpy.data.scenes.remove(sc)
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.cameras,
                  bpy.data.lights, bpy.data.armatures, bpy.data.actions, bpy.data.images):
        for item in list(block):
            block.remove(item)
    _MATS.clear()


# ------------------------------------------------------- karakter blocky

SLOTS = ("skin", "hair", "top", "top2", "accent", "pants", "shoes")
SHARED = ("eye", "pupil", "mouth", "dark")
GROUPS = ("body", "head", "arm.L", "arm.R", "leg.L", "leg.R")


class BlockMesh:
    """Kumpulan kotak (satuan piksel) dengan material & vertex group per kotak."""

    def __init__(self):
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.slots = SLOTS + SHARED

    def add(self, x0, x1, y0, y1, z0, z1, slot, group):
        res = bmesh.ops.create_cube(self.bm, size=1.0)
        verts = res["verts"]
        bmesh.ops.scale(self.bm, vec=(x1 - x0, y1 - y0, z1 - z0), verts=verts)
        bmesh.ops.translate(self.bm, vec=((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), verts=verts)
        mi, gi = self.slots.index(slot), GROUPS.index(group)
        for v in verts:
            v[self.dl][gi] = 1.0
            for f in v.link_faces:
                f.material_index = mi

    def to_mesh(self, name):
        bmesh.ops.scale(self.bm, vec=(PX, PX, PX), verts=self.bm.verts)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        return me


def build_character_mesh(agent):
    lk = agent["look"]
    b = BlockMesh()
    a = b.add
    outfit = lk.get("outfit", "tshirt")

    # kaki: sepatu + celana (atau celana pendek + sandal untuk outfit pantai)
    for side, (x0, x1) in (("leg.L", (0, 4)), ("leg.R", (-4, 0))):
        if outfit == "beach":
            a(x0, x1, -2.1, 2.1, 0, 0.6, "shoes", side)        # sandal
            a(x0, x1, -2, 2, 0.6, 7, "skin", side)
            a(x0 - 0.1 if x0 < 0 else x0, x1 + 0.1 if x1 > 0 else x1, -2.1, 2.1, 7, 12, "pants", side)
        else:
            a(x0, x1, -2, 2, 0, 2.2, "shoes", side)
            a(x0, x1, -2, 2, 2.2, 12, "pants", side)
    # badan
    sleeve = "top"
    a(-4, 4, -2, 2, 12, 24, "top", "body")
    if outfit in ("suit", "blazer"):
        stripe = 1.3 if outfit == "suit" else 2.0
        a(-stripe, stripe, -2.2, -2.0, 15 if outfit == "blazer" else 16, 24, "top2", "body")
        if outfit == "suit":
            a(-0.5, 0.5, -2.35, -2.15, 15, 23.6, "accent", "body")  # dasi
        else:
            for z in (14.0, 16.5):
                a(-2.7, -2.2, -2.3, -2.05, z, z + 0.5, "accent", "body")  # kancing
        a(-4, 4, -2.1, 2.1, 12, 13, "dark", "body")           # ikat pinggang
    elif outfit == "vest":
        sleeve = "top2"                                       # lengan = kemeja
        a(-4, 4, -2, 2, 12, 24, "top2", "body")
        a(-4.1, 4.1, -2.15, 2.15, 13, 22, "top", "body")      # rompi
        a(-1.2, 1.2, -2.25, -2.1, 18, 22.2, "top2", "body")
        a(-0.45, 0.45, -2.35, -2.2, 16, 23.6, "accent", "body")
    elif outfit == "shirt_tie":
        a(-2.4, 2.4, -2.25, -2.0, 23.0, 24, "top2", "body")   # kerah
        a(-0.45, 0.45, -2.35, -2.15, 14, 23.4, "accent", "body")
        a(-4, 4, -2.1, 2.1, 12, 13, "dark", "body")
    elif outfit == "turtleneck":
        a(-2.6, 2.6, -2.4, 2.4, 23.3, 24.8, "top", "body")
        a(-3, 3, -2.15, -2.0, 13, 13.6, "top2", "body")
    elif outfit == "cardigan":
        a(-1.6, 1.6, -2.2, -2.0, 13, 24, "top2", "body")
        for z in (14.5, 17, 19.5):
            a(-2.2, -1.7, -2.3, -2.05, z, z + 0.5, "accent", "body")
    elif outfit == "polo":
        a(-2.3, 2.3, -2.25, -2.0, 23.0, 24, "top2", "body")
        a(-0.4, 0.4, -2.25, -2.05, 20.5, 23.0, "top2", "body")
        a(1.4, 2.4, -2.25, -2.05, 19.8, 20.8, "accent", "body")
    elif outfit == "blouse":
        a(-1.6, 1.6, -2.3, -2.05, 22.3, 23.6, "accent", "body")   # pita
        a(-0.5, 0.5, -2.4, -2.2, 20.6, 22.5, "accent", "body")
    elif outfit == "sweater":
        for x0, x1 in ((-2.2, -0.2), (0.2, 2.2)):
            a(x0, x1, -2.25, -2.0, 22.6, 24, "top2", "body")   # kerah kemeja
        a(-4, 4, -2.1, 2.1, 12, 13.2, "top2", "body")
    elif outfit == "beach":
        a(-1.0, 1.0, -2.2, -2.0, 21.5, 24, "skin", "body")    # kerah terbuka
        flowers = ((-3, 21), (2, 22.5), (-1.5, 16.5), (2.5, 14.5), (-3.2, 13), (0.5, 19))
        for i, (x, z) in enumerate(flowers):
            a(x, x + 1.2, -2.25, -2.0, z, z + 1.2, "top2" if i % 2 else "accent", "body")
            a(x, x + 1.2, 2.0, 2.25, z, z + 1.2, "accent" if i % 2 else "top2", "body")
    elif outfit == "hoodie":
        a(-1.3, 1.3, -2.2, -2.0, 16, 24, "top2", "body")      # kemeja
        a(-0.5, 0.5, -2.35, -2.15, 15, 23.6, "accent", "body")  # dasi
        a(-4, 4, -2.1, 2.1, 12, 13, "dark", "body")           # ikat pinggang
    elif outfit == "hoodie":
        a(-3.5, 3.5, 2.0, 3.0, 20.5, 24.5, "top2", "body")    # tudung
        a(-2.5, 2.5, -2.2, -2.0, 13.5, 16.5, "top2", "body")  # kantong
        for x in (-1.2, 0.8):
            a(x, x + 0.4, -2.3, -2.1, 19.5, 23, "accent", "body")
    else:
        a(-2.2, 2.2, -2.2, -2.0, 23.2, 24, "top2", "body")    # kerah
        a(-1.1, 1.1, -2.2, -2.0, 18.5, 20.7, "accent", "body")  # logo
    # lengan
    sleeve_bottom = {"tshirt": 19, "polo": 19, "beach": 19, "blouse": 16}.get(outfit, 14)
    for side, (x0, x1) in (("arm.L", (4, 8)), ("arm.R", (-8, -4))):
        a(x0, x1, -2, 2, 12, sleeve_bottom, "skin", side)
        a(x0, x1, -2, 2, sleeve_bottom, 24, sleeve, side)
        if outfit == "beach":
            a(x0 + 1, x0 + 2.2, -2.15, -2.0, 20.5, 21.7, "top2", side)
    if lk.get("badge"):
        a(1.6, 3.2, -2.3, -2.05, 17.5, 19.5, "eye", "body")      # ID card
        a(2.1, 2.7, -2.3, -2.05, 19.5, 23.5, "accent", "body")    # tali lanyard
    # kepala & wajah (depan = -Y)
    a(-4, 4, -4, 4, 24, 32, "skin", "head")
    for s in (-1, 1):
        a(*sorted((s * 1, s * 3)), -4.15, -4.0, 27, 28, "eye", "head")
        a(*sorted((s * 1, s * 2)), -4.22, -4.05, 27, 28, "pupil", "head")
        a(*sorted((s * 1, s * 3)), -4.15, -4.0, 28.7, 29.2, "hair", "head")  # alis
    a(-1.5, 1.5, -4.12, -4.0, 25.3, 25.9, "mouth", "head")
    build_hair(a, lk)
    if lk.get("beard"):
        a(-4.25, 4.25, -4.3, -3.6, 24, 25.1, "hair", "head")
        a(-2.2, 2.2, -4.3, -3.9, 26.0, 26.5, "hair", "head")
        for x0, x1 in ((-4.3, -3.7), (3.7, 4.3)):
            a(x0, x1, -4.25, 0.5, 24, 28, "hair", "head")
    if lk.get("glasses"):
        g = ("dark", "head")
        a(-3.6, 3.6, -4.38, -4.18, 28.1, 28.45, *g)
        for x0, x1 in ((-3.4, -0.6), (0.6, 3.4)):
            a(x0, x1, -4.38, -4.18, 26.55, 26.85, *g)
        for x0, x1 in ((-3.6, -3.3), (-0.9, -0.6), (0.6, 0.9), (3.3, 3.6)):
            a(x0, x1, -4.38, -4.18, 26.55, 28.45, *g)
        for x0, x1 in ((-4.35, -4.1), (4.1, 4.35)):
            a(x0, x1, -4.2, 0, 27.8, 28.2, *g)
    if lk.get("sunglasses"):
        a(-3.7, 3.7, -4.4, -4.15, 26.5, 28.5, "dark", "head")
        for x0, x1 in ((-4.4, -4.1), (4.1, 4.4)):
            a(x0, x1, -4.2, 0, 27.6, 28.1, "dark", "head")
    if lk.get("headset"):
        g = ("dark", "head")
        a(-4.5, 4.5, -0.6, 0.6, 32.5, 33.2, *g)
        for x0, x1 in ((-4.7, -4.3), (4.3, 4.7)):
            a(x0, x1, -0.6, 0.6, 29, 33.2, *g)
        for x0, x1 in ((-5.2, -4.3), (4.3, 5.2)):
            a(x0, x1, -1.5, 1.5, 26.5, 29.5, *g)
        a(-4.9, -4.5, -4.5, -1.2, 26.4, 26.8, *g)
        a(-4.9, -3.0, -4.75, -4.35, 26.3, 26.9, "accent", "head")

    me = b.to_mesh(f"{agent['id']}_mesh")
    for slot in SLOTS:
        rough = 0.75 if slot in ("top", "top2", "pants") else 0.55
        me.materials.append(mat(lk.get(slot, "#888888"), rough))
    me.materials.append(mat("#F7F7F7", 0.4))   # eye
    me.materials.append(mat("#20232A", 0.3))   # pupil
    me.materials.append(mat("#7A3B32", 0.6))   # mouth
    me.materials.append(mat("#1A1C20", 0.35))  # dark
    return me


def build_hair(a, lk):
    style = lk.get("hair_style", "short")
    h = ("hair", "head")
    if style in ("short", "messy", "long", "bun", "ponytail"):
        a(-4.25, 4.25, -4.25, 4.25, 31.5, 32.5, *h)            # atas
        a(-4.25, 4.25, 3.6, 4.25, 27, 32, *h)                  # belakang
        for x0, x1 in ((-4.25, -3.75), (3.75, 4.25)):
            a(x0, x1, -4.25, 4.25, 29.5, 32, *h)               # samping
        a(-4.25, 4.25, -4.25, -3.75, 30.8, 32, *h)             # poni
    if style == "messy":
        a(-3, -1, -1, 1, 32.5, 33.3, *h)
        a(1, 2.6, 0, 2, 32.5, 33.0, *h)
        a(-2.5, 0.5, -4.4, -3.6, 30.0, 31.0, *h)
    elif style == "long":
        a(-4.3, 4.3, 3.6, 4.4, 20.5, 32, *h)
        for x0, x1 in ((-4.4, -3.75), (3.75, 4.4)):
            a(x0, x1, -2.5, 4.4, 24.5, 32, *h)
    elif style == "ponytail":
        a(-1.3, 1.3, 4.2, 5.4, 22.5, 30.5, *h)
        a(-1.6, 1.6, 4.0, 5.0, 29.5, 31.0, "accent", "head")
    elif style == "bun":
        a(-1.6, 1.6, 4.0, 6.2, 30.5, 33.6, *h)
    elif style == "cap":
        a(-4.3, 4.3, -4.3, 4.3, 30.5, 32.9, "accent", "head")
        a(-4.3, 4.3, -7.6, -4.3, 30.5, 31.1, "accent", "head")
        a(-1.0, 1.0, -4.45, -4.3, 31.2, 32.4, "top2", "head")
        a(-4.25, 4.25, 3.7, 4.25, 27.5, 30.5, *h)
        for x0, x1 in ((-4.25, -3.75), (3.75, 4.25)):
            a(x0, x1, -1, 4.25, 28.5, 30.5, *h)


def build_rig(agent, col):
    """Armature + mesh berkulit. Depan karakter = -Y, origin di telapak kaki."""
    name = agent["id"]
    arm = bpy.data.armatures.new(f"{name}_rig")
    arm.display_type = "STICK"
    rig = bpy.data.objects.new(f"{name}", arm)
    col.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones

    def bone(bname, head, tail, parent=None):
        b = eb.new(bname)
        b.head = Vector(head) * PX
        b.tail = Vector(tail) * PX
        b.parent = eb[parent] if parent else None
        return b

    bone("root", (0, 0, 0), (0, 0, 5))
    bone("body", (0, 0, 12), (0, 0, 24), "root")
    bone("head", (0, 0, 24), (0, 0, 32), "body")
    bone("arm.L", (6, 0, 22), (6, 0, 12), "body")
    bone("arm.R", (-6, 0, 22), (-6, 0, 12), "body")
    bone("leg.L", (2, 0, 12), (2, 0, 0), "body")
    bone("leg.R", (-2, 0, 12), (-2, 0, 0), "body")
    eb["root"].use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"

    me = build_character_mesh(agent)
    body = bpy.data.objects.new(f"{name}_body", me)
    col.objects.link(body)
    for g in GROUPS:
        body.vertex_groups.new(name=g)
    body.parent = rig
    mod = body.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    rig["agent_id"] = name
    rig["role"] = agent["role"]
    rig["camp"] = agent.get("camp", "")
    return rig


# ------------------------------------------------------------- pose/aksi
# Nilai rotasi X (radian) per tulang; negatif = ayun ke depan.
# "root_z" = turunnya badan (dipakai saat duduk), "head_yaw" = tengok.

def pose_stand(t):
    s = math.sin(t * 0.12) * 0.03
    return {"arm.L": s, "arm.R": -s, "leg.L": 0, "leg.R": 0, "head": 0, "root_z": 0}


def pose_walk(t):
    s = math.sin(2 * math.pi * t / STRIDE_F)
    bob = abs(math.cos(2 * math.pi * t / STRIDE_F)) * 0.02
    return {"leg.L": 0.6 * s, "leg.R": -0.6 * s, "arm.L": -0.55 * s, "arm.R": 0.55 * s,
            "head": 0, "root_z": bob - 0.02}


def pose_sit(arms=-0.35):
    return {"leg.L": -math.pi / 2, "leg.R": -math.pi / 2, "arm.L": arms, "arm.R": arms,
            "head": 0, "root_z": SIT_DROP}


def pose_type(t):
    p = pose_sit(-1.05)
    p["arm.L"] += 0.07 * math.sin(t * 1.9)
    p["arm.R"] += 0.07 * math.sin(t * 1.9 + 2.0)
    p["head"] = 0.12
    return p


def pose_talk(t):
    p = pose_sit(-0.95)
    p["arm.R"] = -1.55 + 0.3 * math.sin(t * 0.45)
    p["arm.L"] = -1.0 + 0.12 * math.sin(t * 0.45 + 1.3)
    p["head"] = -0.06 + 0.07 * math.sin(t * 0.6)
    return p


def pose_listen(t):
    p = pose_sit(-0.95)
    p["head"] = 0.03 * math.sin(t * 0.05)
    return p


def apply_pose(rig, pose, frame=None):
    pbs = rig.pose.bones
    for bname in ("leg.L", "leg.R", "arm.L", "arm.R"):
        pbs[bname].rotation_euler = (pose.get(bname, 0.0), 0, 0)
    pbs["head"].rotation_euler = (pose.get("head", 0.0), pose.get("head_yaw", 0.0), 0)
    pbs["root"].location = (0, pose.get("root_z", 0.0), 0)   # sumbu Y root = ke atas
    if frame is not None:
        for bname in ("leg.L", "leg.R", "arm.L", "arm.R", "head"):
            pbs[bname].keyframe_insert("rotation_euler", frame=frame)
        pbs["root"].keyframe_insert("location", frame=frame)


def make_library_actions(rig):
    """Action siap pakai untuk dianimasikan ulang di NLA / game engine."""
    lib = {
        "QB_Idle": (48, lambda t: pose_stand(t * 4)),
        "QB_Walk": (STRIDE_F, pose_walk),
        "QB_Sit_Down": (SIT_F, lambda t: lerp_pose(pose_stand(0), pose_sit(), smooth(t / SIT_F))),
        "QB_Sit_Typing": (24, pose_type),
        "QB_Sit_Talk": (48, pose_talk),
        "QB_Sit_Listen": (48, pose_listen),
    }
    rig.animation_data_create()
    for name, (length, fn) in lib.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        for f in range(0, length + 1, 2):
            apply_pose(rig, fn(f), frame=f + 1)
    rig.animation_data.action = None


# ------------------------------------------------------ rencana gerak

def polyline(points):
    segs, total = [], 0.0
    for p0, p1 in zip(points, points[1:]):
        length = (p1 - p0).length
        segs.append((p0, p1, length, total))
        total += length

    def at(d):
        d = max(0.0, min(total, d))
        for p0, p1, length, start in segs:
            if d <= start + length:
                return p0.lerp(p1, (d - start) / length if length else 0.0)
        return segs[-1][1].copy()

    return at, total


class Plan:
    """Jadwal satu agen: kerja di meja -> berdiri -> jalan -> duduk di Meeting Room."""

    def __init__(self, agent_id, desk, path, seat, seat_yaw, f_stand):
        self.id = agent_id
        self.desk, self.seat, self.seat_yaw = desk, seat, seat_yaw
        self.walk_at, self.length = polyline([desk] + path + [seat])
        self.f_stand = f_stand
        self.f_walk = f_stand + STAND_F
        self.f_arrive = self.f_walk + math.ceil(self.length / WALK_SPEED)
        self.f_turned = self.f_arrive + TURN_F
        self.f_seated = self.f_turned + SIT_F

    def _walk_yaw(self, d):
        return yaw_of(self.walk_at(d + 0.3) - self.walk_at(d - 0.3))

    def loc(self, f):
        if f < self.f_walk:
            return self.desk
        if f < self.f_arrive:
            return self.walk_at((f - self.f_walk) * WALK_SPEED)
        return self.seat

    def yaw(self, f):
        if f < self.f_stand:
            return 0.0
        if f < self.f_walk:
            u = smooth((f - self.f_stand) / STAND_F)
            return wrap(self._walk_yaw(0.0)) * u
        if f < self.f_arrive:
            return self._walk_yaw((f - self.f_walk) * WALK_SPEED)
        last = self._walk_yaw(self.length)
        u = smooth((f - self.f_arrive) / TURN_F)
        return last + wrap(self.seat_yaw - last) * u

    def pose(self, f, speaking, look_yaw):
        """look_yaw: yaw dunia ke arah pembicara (None = tidak menengok)."""
        if f < self.f_stand:
            p = pose_talk(f) if speaking else pose_type(f)
        elif f < self.f_walk:
            p = lerp_pose(pose_type(f), pose_stand(f), smooth((f - self.f_stand) / STAND_F))
        elif f < self.f_arrive:
            u = min(1.0, (f - self.f_walk) / 6, (self.f_arrive - f) / 6)
            p = lerp_pose(pose_stand(f), pose_walk(f - self.f_walk), u)
        elif f < self.f_turned:
            p = pose_stand(f)
        elif f < self.f_seated:
            p = lerp_pose(pose_stand(f), pose_listen(f), smooth((f - self.f_turned) / SIT_F))
        else:
            p = pose_talk(f) if speaking else pose_listen(f)
        if look_yaw is not None and not speaking and (f < self.f_stand or f >= self.f_seated):
            p["head_yaw"] = max(-1.1, min(1.1, wrap(look_yaw - self.yaw(f))))
        return p


def bake(rig, plan, plans, speeches, frame_end):
    rig.animation_data_create()
    rig.animation_data.action = bpy.data.actions.new(f"{plan.id}_Demo")
    frames = list(range(1, frame_end + 1, KEY_STEP))
    poses, prev_yaw, head = [], 0.0, 0.0
    for f in frames:
        speaker = next((s for s in speeches if s[1] <= f < s[2]), None)
        speaking = speaker is not None and speaker[0] == plan.id
        look = None
        if speaker and not speaking:
            look = yaw_of(plans[speaker[0]].loc(f) - plan.loc(f))
        p = plan.pose(f, speaking, look)
        head += (p.get("head_yaw", 0.0) - head) * 0.35   # tengok halus
        p["head_yaw"] = head
        yaw = plan.yaw(f)
        yaw = prev_yaw + wrap(yaw - prev_yaw)
        prev_yaw = yaw
        poses.append((f, plan.loc(f), yaw, p))
    for f, loc, yaw, p in poses:
        rig.location = (loc.x, loc.y, getattr(plan, "z", 0.0))
        rig.rotation_euler = (0, 0, yaw)
        rig.keyframe_insert("location", frame=f)
        rig.keyframe_insert("rotation_euler", index=2, frame=f)
        apply_pose(rig, p, frame=f)


# ------------------------------------------------------------ chat bubble

def bubble_mesh(name, w, h, color_hex, col, depth=0.04, r=0.1):
    """Gelembung chat: persegi panjang bersudut bulat + ekor, di bidang XY
    (menghadap +Z) dengan ujung ekor di origin."""
    outline = []
    cy = 0.16 + h / 2
    for cx_, cy_, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
                         (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for k in range(6):
            a = math.radians(a0 + k * 18)
            outline.append((cx_ + r * math.cos(a), cy + cy_ + r * math.sin(a)))
    # sisipkan ekor di sisi bawah (antara sudut kiri-bawah dan kanan-bawah)
    bottom = 0.16
    outline[18:18] = [(-0.2, bottom), (-0.12, 0.0), (0.02, bottom)]
    bm = bmesh.new()
    front = [bm.verts.new((x, y, depth / 2)) for x, y in outline]
    back = [bm.verts.new((x, y, -depth / 2)) for x, y in outline]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(outline)
    for i in range(n):
        bm.faces.new((back[i], back[(i + 1) % n], front[(i + 1) % n], front[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat(color_hex, 0.4, emit=0.35))
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.visible_shadow = False
    return ob


def make_bubble(name, agent_id, message, accent_hex, col, camera):
    """Chat bubble: border warna agen, nama agen, teks pesan. Kembalikan root Empty."""
    size, cpl = 0.15, 24
    lines = textwrap.wrap(message, cpl)
    w = max(len(agent_id) * size * 0.75, max(len(s) for s in lines) * size * 0.56) + 0.4
    h = (len(lines) + 1) * size * 1.3 + 0.2
    root = bpy.data.objects.new(name, None)
    root.empty_display_size = 0.1
    col.objects.link(root)
    rot = root.constraints.new("COPY_ROTATION")
    rot.target = camera
    border = bubble_mesh(f"{name}_border", w + 0.1, h + 0.1, accent_hex, col)
    border.parent = root
    border.location = (0, -0.05, -0.03)
    face = bubble_mesh(f"{name}_face", w, h, "#FBFBF7", col)
    face.parent = root
    top = 0.16 + h - 0.12
    label = text(f"{name}_name", agent_id, (-w / 2 + 0.2, top - size, 0.045), size * 0.9,
                 mat(accent_hex, 0.4, emit=0.6), col, parent=root, standing=False,
                 align="LEFT", yaw_deg=0)
    label.data.align_y = "BOTTOM"
    msg = text(f"{name}_text", "\n".join(lines), (-w / 2 + 0.2, top - size * 2.3, 0.045), size,
               mat("#1E2329", 0.5), col, parent=root, standing=False, align="LEFT", yaw_deg=0)
    msg.data.align_y = "TOP_BASELINE"
    for ob in (label, msg):
        ob.visible_shadow = False
    return root


def attach_bubble(root, rig, f0, f1):
    root.parent = rig
    root.parent_type = "BONE"
    root.parent_bone = "head"
    root.location = (0.18, 0.18, 0)   # relatif ujung tulang kepala (Y = ke atas)
    for f, s in ((1, 0.0), (f0 - 1, 0.0), (f0 + 4, 1.12), (f0 + 7, 1.0), (f1 - 5, 1.0), (f1, 0.0)):
        root.scale = (s, s, s)
        root.keyframe_insert("scale", frame=max(1, f))


# ----------------------------------------------------------------- kantor

def floor_material(name, c1, c2, scale):
    m = bpy.data.materials.new(name)
    if bpy.app.version < (5, 0):
        m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.7
    coord = nt.nodes.new("ShaderNodeTexCoord")
    chk = nt.nodes.new("ShaderNodeTexChecker")
    chk.inputs["Color1"].default_value = hex_rgba(c1)
    chk.inputs["Color2"].default_value = hex_rgba(c2)
    chk.inputs["Scale"].default_value = scale
    nt.links.new(coord.outputs["Object"], chk.inputs["Vector"])
    nt.links.new(chk.outputs["Color"], bsdf.inputs["Base Color"])
    m.diffuse_color = hex_rgba(c1)
    return m


def palette():
    return {
        "wall": mat("#EEF0F2", 0.85),
        "base": mat("#2B2F38", 0.6),
        "desk": mat("#E9E4DA", 0.55),
        "desk_leg": mat("#3A3F48", 0.4, metal=0.6),
        "monitor": mat("#16181C", 0.35),
        "screen": mat("#0E1726", 0.3, emit=0.8),
        "green": mat("#26DE81", 0.3, emit=4.0),
        "red": mat("#FF4D5E", 0.3, emit=4.0),
        "cyan": mat("#35C9FF", 0.3, emit=5.0),
        "glass": mat("#DDEEFF", 0.03, glass=True),
        "frame": mat("#2D3138", 0.4),
        "wood": mat("#7A5434", 0.55),
        "white": mat("#F5F5F2", 0.5),
        "label": mat("#242830", 0.5),
        "leaf": mat("#4CAF50", 0.8),
        "leaf2": mat("#3D8B40", 0.8),
        "pot": mat("#9C6B43", 0.7),
        "black": mat("#111216", 0.4),
    }


def candle_chart(prefix, origin, width, height, n, P, col, parent=None, seed=1, axis="x", facing=-1):
    """Grafik candlestick dari kotak emisif pada bidang vertikal."""
    price, step = 0.5, width / n
    vals = []
    for i in range(n):
        seed = (seed * 1103515245 + 12345) % 2 ** 31
        move = ((seed >> 8) % 1000 / 1000 - 0.42) * 0.18
        o, c = price, max(0.08, min(0.92, price + move))
        vals.append((o, c))
        price = c
    for i, (o, c) in enumerate(vals):
        lo, hi = sorted((o, c))
        along = -width / 2 + step * (i + 0.5)
        body_h = max(0.01, (hi - lo) * height)
        pos = Vector(origin)
        offset = Vector((along, 0, 0)) if axis == "x" else Vector((0, along, 0))
        size = (step * 0.6, 0.012, body_h) if axis == "x" else (0.012, step * 0.6, body_h)
        wick = (step * 0.12, 0.008, body_h + height * 0.06) if axis == "x" else (0.008, step * 0.12, body_h + height * 0.06)
        m = P["green"] if c >= o else P["red"]
        box(f"{prefix}_c{i}", size, pos + offset + Vector((0, 0, lo * height)), m, col,
            parent=parent, bevel=0)
        box(f"{prefix}_w{i}", wick, pos + offset + Vector((0, 0, lo * height - height * 0.03)),
            m, col, parent=parent, bevel=0)


def build_plant(name, loc, P, col):
    box(f"{name}_pot", (0.42, 0.42, 0.4), loc, P["pot"], col, bevel=0.01)
    box(f"{name}_soil", (0.36, 0.36, 0.02), (loc[0], loc[1], 0.4), P["black"], col, bevel=0)
    box(f"{name}_trunk", (0.1, 0.1, 0.5), (loc[0], loc[1], 0.4), P["wood"], col, bevel=0)
    for i, (dx, dy, dz, s) in enumerate(((0, 0, 0.85, 0.6), (0.2, -0.1, 1.2, 0.4),
                                         (-0.15, 0.15, 1.25, 0.38), (0, 0, 1.45, 0.3))):
        box(f"{name}_leaf{i}", (s, s, s), (loc[0] + dx, loc[1] + dy, dz),
            P["leaf"] if i % 2 == 0 else P["leaf2"], col, bevel=0.005)


def build_office(data, P):
    col = collection("Quantbot_Office")
    o = data["office"]
    box("Base", (W + 1.2, D + 2.4, 0.4), (0, -0.6, -0.42), P["base"], col, bevel=0.05)
    box("Floor_Work", (MEET_X0 + W / 2, D, 0.02), ((MEET_X0 - W / 2) / 2, 0, -0.02),
                floor_material("Floor_Checker", "#D9DEE3", "#C8CFD6", 1.0), col, bevel=0)
    box("Floor_Meeting", (W / 2 - MEET_X0, D, 0.02), ((MEET_X0 + W / 2) / 2, 0, -0.02),
        floor_material("Floor_Carpet", "#46566B", "#3E4C60", 1.0), col, bevel=0)
    t = 0.15
    box("Wall_Back", (W + t, t, WALL_H), (-t / 2, D / 2 + t / 2, 0), P["wall"], col, bevel=0.01)
    box("Wall_Left", (t, D, WALL_H), (-W / 2 - t / 2, 0, 0), P["wall"], col, bevel=0.01)

    # logo QUANTBOT di dinding belakang area kerja
    sign_x = -3.6   # di kanan layar ticker, tidak bertumpuk
    box("Sign_Panel", (5.4, 0.08, 1.15), (sign_x, D / 2 - 0.04, 1.55), P["black"], col, bevel=0.03)
    logo = text("Sign_QUANTBOT", o["name"], (sign_x, D / 2 - 0.1, 1.85), 0.62, P["cyan"], col,
                yaw_deg=0)
    logo.data.extrude = 0.03
    text("Sign_Tagline", o.get("tagline", "").upper(), (sign_x, D / 2 - 0.1, 1.66), 0.16,
         P["white"], col, yaw_deg=0)
    # ticker chart besar di sisi kiri logo
    box("Ticker_Frame", (2.2, 0.06, 1.2), (-W / 2 + 1.3, D / 2 - 0.03, 1.4), P["monitor"], col, bevel=0.02)
    box("Ticker_Screen", (2.05, 0.01, 1.05), (-W / 2 + 1.3, D / 2 - 0.065, 1.475), P["screen"], col, bevel=0)
    candle_chart("Ticker", (-W / 2 + 1.3, D / 2 - 0.08, 1.55), 1.85, 0.85, 22, P, col, seed=7)

    for i, (x, y) in enumerate(((-8.4, 4.4), (-8.4, -4.4), (0.2, 4.4), (8.5, 1.2))):
        build_plant(f"Plant_{i}", (x, y, 0), P, col)


def build_desk(agent, x, y, P, col):
    """Meja kerja di depan kursi (kursi di (x, y), agen menghadap -Y)."""
    name, lk = agent["id"], agent["look"]
    g = empty(f"Desk_{name}", (x, y, 0), 0, col)
    g["agent_id"] = name
    dy = -0.6
    box(f"{g.name}_top", (1.6, 0.8, 0.05), (0, dy, 0.71), P["desk"], col, g)
    for sx in (-0.75, 0.75):
        box(f"{g.name}_leg{sx:+.0f}", (0.06, 0.7, 0.71), (sx, dy, 0), P["desk_leg"], col, g)
    box(f"{g.name}_panel", (1.44, 0.03, 0.42), (0, dy - 0.36, 0.28), mat(lk["top"], 0.6), col, g)
    text(f"{g.name}_name", name, (0, dy - 0.39, 0.5), 0.13, P["white"], col, g, yaw_deg=0)
    text(f"{g.name}_role", agent["role"].upper(), (0, dy - 0.39, 0.36), 0.06, P["white"], col, g,
         yaw_deg=0)
    # dua monitor, layar menghadap agen (+Y)
    for k, mx in enumerate((-0.33, 0.33)):
        m = empty(f"{g.name}_mon{k}", (mx, dy - 0.22, 0.76), 180 + (12 if k == 0 else -12), col, g)
        box(f"{m.name}_stand", (0.18, 0.12, 0.02), (0, 0, 0), P["monitor"], col, m)
        box(f"{m.name}_neck", (0.04, 0.03, 0.12), (0, 0.03, 0.02), P["monitor"], col, m)
        box(f"{m.name}_body", (0.58, 0.03, 0.34), (0, 0, 0.12), P["monitor"], col, m)
        box(f"{m.name}_scr", (0.54, 0.005, 0.3), (0, -0.017, 0.14), P["screen"], col, m, bevel=0)
        candle_chart(f"{m.name}_ch", (0, -0.022, 0.16), 0.48, 0.24, 12, P, col, parent=m,
                     seed=sum(map(ord, name)) * 7 + k)
    box(f"{g.name}_kbd", (0.44, 0.15, 0.02), (0, -0.42, 0.76), P["monitor"], col, g)
    box(f"{g.name}_mug", (0.08, 0.08, 0.1), (0.62, -0.5, 0.76), mat(lk["accent"], 0.5), col, g)
    build_chair(f"Chair_{name}", (x, y), 0, lk["top"], P, col)


def build_chair(name, pos, yaw_deg, color_hex, P, col):
    g = empty(name, (pos[0], pos[1], 0), yaw_deg, col)
    cyl(f"{name}_base", 0.28, 0.05, (0, 0, 0.02), P["black"], col, g, segs=5)
    cyl(f"{name}_pole", 0.035, 0.3, (0, 0, 0.07), P["desk_leg"], col, g)
    box(f"{name}_seat", (0.52, 0.5, 0.08), (0, 0.04, SEAT_H - 0.08), mat(color_hex, 0.7), col, g)
    box(f"{name}_back", (0.5, 0.08, 0.62), (0, 0.32, SEAT_H), mat(color_hex, 0.7), col, g)
    return g


def build_meeting_room(data, P):
    col = collection("Meeting_Room")
    x_mid = (MEET_X0 + W / 2) / 2
    # dinding kaca barat dengan pintu, pagar kaca rendah di depan
    for y0, y1 in ((-D / 2, DOOR_Y - 0.65), (DOOR_Y + 0.65, D / 2)):
        mid = (MEET_X0, (y0 + y1) / 2, 0)
        box(f"Glass_W_{y0:+.1f}", (0.04, y1 - y0, 2.5), mid, P["glass"], col, bevel=0)
        box(f"Glass_W_{y0:+.1f}_top", (0.08, y1 - y0, 0.08), (mid[0], mid[1], 2.5), P["frame"], col, bevel=0)
        box(f"Glass_W_{y0:+.1f}_rail", (0.08, y1 - y0, 0.06), mid, P["frame"], col, bevel=0)
    box("Glass_Front", (W / 2 - MEET_X0, 0.04, 0.9), (x_mid, -D / 2, 0), P["glass"], col, bevel=0)
    box("Glass_Front_rail", (W / 2 - MEET_X0, 0.08, 0.06), (x_mid, -D / 2, 0.9), P["frame"], col, bevel=0)

    # papan nama + layar debat di dinding belakang
    box("MR_Sign_Panel", (4.6, 0.08, 0.6), (TABLE_C.x, D / 2 - 0.04, 2.25), P["black"], col, bevel=0.03)
    sign = text("MR_Sign", "MEETING ROOM", (TABLE_C.x, D / 2 - 0.1, 2.36), 0.36, P["cyan"], col, yaw_deg=0)
    sign.data.extrude = 0.02
    box("MR_Screen_Frame", (3.0, 0.06, 1.25), (TABLE_C.x, D / 2 - 0.03, 0.85), P["monitor"], col, bevel=0.02)
    box("MR_Screen", (2.85, 0.01, 1.1), (TABLE_C.x, D / 2 - 0.065, 0.925), P["screen"], col, bevel=0)
    candle_chart("MR_Chart", (TABLE_C.x, D / 2 - 0.08, 1.0), 2.6, 0.8, 28, P, col, seed=42)
    text("MR_Pair", "BTC/USDT  4H", (TABLE_C.x - 1.3, D / 2 - 0.08, 1.85), 0.1, P["white"], col,
         yaw_deg=0, align="LEFT")

    # meja debat + papan kubu
    tw, tl = TABLE_SIZE
    box("Debate_Table", (tw, tl, 0.06), (TABLE_C.x, TABLE_C.y, 0.71), P["wood"], col, bevel=0.02)
    for dy in (-tl / 2 + 0.5, tl / 2 - 0.5):
        box(f"Debate_Table_leg{dy:+.0f}", (0.5, 0.12, 0.71), (TABLE_C.x, TABLE_C.y + dy, 0), P["desk_leg"], col)
    box("Debate_Table_stripe", (0.12, tl - 0.3, 0.005), (TABLE_C.x, TABLE_C.y, 0.77), P["cyan"], col, bevel=0)
    for label, x, m in (("BULL", WEST_X + 0.55, P["green"]), ("BEAR", EAST_X - 0.55, P["red"])):
        tag = text(f"Camp_{label}", label, (x, TABLE_C.y - tl / 2 + 0.25, 0.775), 0.2, m, col,
                   standing=False, yaw_deg=0)
        tag.data.extrude = 0.01
    text("MR_Floor_Label", "MEETING ROOM", (MEET_X0 + 0.25, -D / 2 + 0.3, 0.005), 0.28,
         P["white"], col, standing=False, align="LEFT", yaw_deg=0)
    text("Work_Floor_Label", "TRADING FLOOR", (-W / 2 + 0.25, -D / 2 + 0.3, 0.005), 0.28,
         P["label"], col, standing=False, align="LEFT", yaw_deg=0)


def meeting_seats(agents):
    """Kepala meja = moderator; barat = bull (+ netral); timur = bear (+ netral)."""
    west = [a["id"] for a in agents if a["camp"] == "bull"]
    east = [a["id"] for a in agents if a["camp"] == "bear"]
    for a in agents:
        if a["camp"] == "neutral":
            (west if len(west) <= len(east) else east).append(a["id"])
    seats = {}
    head = next(a["id"] for a in agents if a["camp"] == "moderator")
    seats[head] = (HEAD_SEAT, 0.0, [Vector((7.2, DOOR_Y)), Vector((7.2, HEAD_SEAT.y))])
    for ids, x, yaw, lane in ((west, WEST_X, math.pi / 2, 3.3), (east, EAST_X, -math.pi / 2, 7.2)):
        for aid, y in zip(ids, SIDE_SEATS_Y):
            seats[aid] = (Vector((x, y)), yaw, [Vector((lane, DOOR_Y)), Vector((lane, y))])
    return seats


# -------------------------------------------------------------- dekorasi

CRYPTO_LOGOS = ("BTC", "ETH", "SOL", "XRP", "BNB", "ONDO", "LINK")
CRYPTO_NAMES = {"BTC": "BITCOIN", "ETH": "ETHEREUM", "SOL": "SOLANA", "XRP": "XRP",
                "BNB": "BNB", "ONDO": "ONDO", "LINK": "CHAINLINK"}


def flat_shape(name, pts, depth, y, material, col, parent):
    """Relief datar dari poligon (x, z) di bidang yang menghadap -Y."""
    bm = bmesh.new()
    front = [bm.verts.new((x, y - depth / 2, z)) for x, z in pts]
    back = [bm.verts.new((x, y + depth / 2, z)) for x, z in pts]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    n = len(pts)
    for i in range(n):
        bm.faces.new((front[i], front[(i + 1) % n], back[(i + 1) % n], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    ob = bpy.data.objects.new(name, me)
    col.objects.link(ob)
    ob.parent = parent
    return ob


def disc(name, r, depth, y, material, col, parent, segs=48, cx=0.0, cz=0.0):
    pts = [(cx + r * math.cos(2 * math.pi * i / segs), cz + r * math.sin(2 * math.pi * i / segs))
           for i in range(segs)]
    ob = flat_shape(name, pts, depth, y, material, col, parent)
    for poly in ob.data.polygons:
        poly.use_smooth = len(poly.vertices) == 4
    return ob


def half_disc(r, cx, cz, start_deg, segs=16):
    return [(cx + r * math.cos(math.radians(start_deg + 180 * i / segs)),
             cz + r * math.sin(math.radians(start_deg + 180 * i / segs))) for i in range(segs + 1)]


def crypto_logo(sym, g, col, r=0.36):
    """Logo kripto sederhana (relief) di depan piringan; depan = -Y lokal."""
    fy = -0.05   # bidang muka simbol
    def m(hexc, emit=0.0):
        return mat(hexc, 0.35, emit=emit)
    disc(f"{g.name}_rim", r + 0.035, 0.05, 0.0, m("#2B2F36"), col, g)
    if sym == "BTC":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#F7931A"), col, g)
        b = text(f"{g.name}_B", "B", (0.01, fy, -0.17), 0.46, m("#FFFFFF"), col, g, yaw_deg=0)
        b.data.extrude = 0.012
        for x in (-0.06, 0.0):
            for z0, z1 in ((0.15, 0.22), (-0.22, -0.15)):
                flat_shape(f"{g.name}_bar", [(x - 0.016, z0), (x + 0.016, z0), (x + 0.016, z1), (x - 0.016, z1)],
                           0.024, fy, m("#FFFFFF"), col, g)
    elif sym == "ETH":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#ECEFF4"), col, g)
        for side, shade in ((-1, "#8A9FF0"), (1, "#627EEA")):
            flat_shape(f"{g.name}_top{side}", [(0, 0.27), (0, -0.04), (0.15 * side, 0.03)], 0.03, fy,
                       m(shade), col, g)
            flat_shape(f"{g.name}_bot{side}", [(0, -0.09), (0, -0.28), (0.15 * side, -0.02)], 0.03, fy,
                       m(shade), col, g)
    elif sym == "SOL":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#0B0B12"), col, g)
        for zc, d, c in ((0.11, 0.045, "#00FFA3"), (0.0, -0.045, "#7F8CF0"), (-0.11, 0.045, "#DC1FFF")):
            h = 0.034
            flat_shape(f"{g.name}_bar{zc:+.2f}", [(-0.17 - d, zc - h), (0.17 - d, zc - h), (0.17 + d, zc + h),
                                                  (-0.17 + d, zc + h)], 0.03, fy, m(c, 1.2), col, g)
    elif sym == "XRP":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#23292F"), col, g)
        for s in (1, -1):
            pts = [(-0.19, 0.19 * s), (-0.11, 0.19 * s), (0, 0.08 * s), (0.11, 0.19 * s), (0.19, 0.19 * s),
                   (0.035, 0.035 * s), (-0.035, 0.035 * s)]
            if s < 0:
                pts = list(reversed(pts))
            flat_shape(f"{g.name}_v{s:+d}", pts, 0.03, fy, m("#FFFFFF"), col, g)
    elif sym == "BNB":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#1E2026"), col, g)
        gold = m("#F3BA2F", 0.6)
        def diamond(cx, cz, k):
            return [(cx, cz + k), (cx + k, cz), (cx, cz - k), (cx - k, cz)]
        flat_shape(f"{g.name}_c", diamond(0, 0, 0.075), 0.03, fy, gold, col, g)
        for i, (cx, cz) in enumerate(((0.16, 0), (-0.16, 0), (0, 0.16), (0, -0.16))):
            flat_shape(f"{g.name}_d{i}", diamond(cx, cz, 0.045), 0.03, fy, gold, col, g)
    elif sym == "ONDO":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#101C3D"), col, g)
        flat_shape(f"{g.name}_l", half_disc(0.16, -0.02, 0.025, 90), 0.03, fy, m("#FFFFFF"), col, g)
        flat_shape(f"{g.name}_r", half_disc(0.16, 0.02, -0.025, 270), 0.03, fy, m("#FFFFFF"), col, g)
    elif sym == "LINK":
        disc(f"{g.name}_bg", r, 0.06, -0.01, m("#FFFFFF"), col, g)
        blue = m("#2A5ADA")
        for i in range(6):
            a0, a1 = math.radians(90 + 60 * i), math.radians(150 + 60 * i)
            ro, ri = 0.22, 0.13
            flat_shape(f"{g.name}_hex{i}", [(ro * math.cos(a0), ro * math.sin(a0)), (ro * math.cos(a1), ro * math.sin(a1)),
                                            (ri * math.cos(a1), ri * math.sin(a1)), (ri * math.cos(a0), ri * math.sin(a0))],
                       0.03, fy, blue, col, g)


PIXEL_ART = {
    "To_The_Moon": (
        {"k": "#0B1030", "s": "#FFFFFF", "m": "#F4E7B0", "M": "#D8C784", "r": "#E8E8E8",
         "R": "#E04848", "w": "#4FC3F7", "f": "#FFA726", "F": "#FFEB3B"},
        ["kkkkkkkkkkkkkkkk",
         "kksskkkkkkkkmmkk",
         "kkkkkkkkkkkmmMmk",
         "kkkkkkskkkkmMmmk",
         "kkkkkkkkkkkkmmkk",
         "kkkkkkRkkkkkkkkk",
         "ksskkrrrkkkkkskk",
         "kkkkkrwrkkkkkkkk",
         "kkkkkrrrkkkskkkk",
         "kkkkRrrrRkkkkkkk",
         "kkkkkfFfkkkkkkkk",
         "kkkkkkfkkkkksskk"]),
    "Sunset_Peaks": (
        {"p": "#F27E8A", "o": "#FF9E5E", "y": "#FFE07A", "d": "#4A3F6B", "D": "#2E2748",
         "g": "#3E8E5E", "G": "#2F6B47", "b": "#3A6EA5"},
        ["pppppppppppppppp",
         "ppppppppppyypppp",
         "ooooooooyyyyoooo",
         "oooooooyyyyyyooo",
         "ooooodoooyyyyooo",
         "oooodddoooooooDo",
         "ooodddddoooooDDD",
         "oodddddddooDDDDD",
         "odddddddddDDDDDD",
         "gggggggggggggggg",
         "bbbbbbbbbbbbbbbb",
         "GgGgGgGgGgGgGgGg"]),
    "HODL": (
        {"k": "#11131A", "H": "#26DE81", "O": "#F7931A", "D": "#35C9FF", "L": "#DC1FFF"},
        ["kkkkkkkkkkkkkkkk",
         "kHkHkOOOkDDkkLkk",
         "kHkHkOkOkDkDkLkk",
         "kHHHkOkOkDkDkLkk",
         "kHkHkOkOkDkDkLkk",
         "kHkHkOOOkDDkkLLL",
         "kkkkkkkkkkkkkkkk"]),
}


def pixel_image(name, palette_map, rows):
    h, w = len(rows), len(rows[0])
    assert all(len(r) == w for r in rows), name
    img = bpy.data.images.new(name, w, h, alpha=False)
    px = []
    for row in reversed(rows):   # piksel Blender dimulai dari baris bawah
        for ch in row:
            px.extend(hex_rgba(palette_map[ch]))
    img.pixels = px
    img.pack()
    return img


def painting(name, art, center, size, col, yaw_deg=0, frame_hex="#6B4A2E", emit=0.25):
    """Lukisan pixel art berbingkai kayu (gaya lukisan Minecraft) menghadap -Y lokal."""
    pal, rows = PIXEL_ART[art]
    img = pixel_image(f"IMG_{art}", pal, rows)
    m = bpy.data.materials.new(f"Paint_{art}")
    if bpy.app.version < (5, 0):
        m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = emit
    bsdf.inputs["Roughness"].default_value = 0.8
    g = empty(name, center, yaw_deg, col)
    w, h = size
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    verts = [bm.verts.new((x, -0.03, z)) for x, z in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
    face = bm.faces.new(verts)
    for loop, co in zip(face.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = co
    me = bpy.data.meshes.new(f"{name}_canvas")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(m)
    canvas = bpy.data.objects.new(f"{name}_canvas", me)
    col.objects.link(canvas)
    canvas.parent = g
    fm, t = mat(frame_hex, 0.6), 0.07
    box(f"{name}_back", (w, 0.03, h), (0, -0.0, -h / 2), mat("#3A2A1C", 0.8), col, g, bevel=0)
    for sx, sz, x, z in ((w + 2 * t, t, 0, h / 2), (w + 2 * t, t, 0, -h / 2 - t), (t, h, -w / 2 - t / 2, -h / 2),
                         (t, h, w / 2 + t / 2, -h / 2)):
        box(f"{name}_frame", (sx, 0.06, sz), (x, -0.02, z), fm, col, g, bevel=0.01)
    return g


def coin_hologram(name, pos, col, kind):
    """Pedestal dengan koin/kristal yang berputar terus (driver dari nomor frame)."""
    g = empty(name, (pos[0], pos[1], 0), 0, col)
    cyl(f"{name}_ped", 0.32, 0.75, (0, 0, 0), mat("#20242C", 0.4), col, g, segs=8)
    cyl(f"{name}_glow", 0.26, 0.02, (0, 0, 0.75), mat("#35C9FF", 0.3, emit=6.0), col, g, segs=32)
    spin = empty(f"{name}_spin", (0, 0, 1.35), 0, col, g)
    if kind == "BTC":
        coin = empty(f"{name}_coin", (0, 0, 0), 0, col, spin)
        crypto_logo("BTC", coin, col, r=0.3)
        back = empty(f"{name}_coin_back", (0, 0, 0), 180, col, spin)
        crypto_logo("BTC", back, col, r=0.3)
    else:
        top = mat("#8A9FF0", 0.25, emit=1.5)
        bot = mat("#627EEA", 0.25, emit=1.5)
        cyl(f"{name}_up", 0.22, 0.42, (0, 0, -0.02), top, col, spin, r2=0.0, segs=4)
        cyl(f"{name}_dn", 0.0, 0.26, (0, 0, -0.3), bot, col, spin, r2=0.22, segs=4)
    fc = spin.driver_add("rotation_euler", 2)
    fc.driver.expression = "frame * 0.06"
    return g


def build_decor(P):
    col = collection("Decor")
    # dinding kiri: deretan logo kripto (menghadap +X)
    n = len(CRYPTO_LOGOS)
    for i, sym in enumerate(CRYPTO_LOGOS):
        y = (i - (n - 1) / 2) * 1.25
        g = empty(f"Logo_{sym}", (-W / 2 + 0.06, y, 1.95), 90, col)
        g["symbol"] = sym
        crypto_logo(sym, g, col)
        text(f"Logo_{sym}_label", CRYPTO_NAMES[sym], (0, -0.03, -0.56), 0.1, P["label"], col, g, yaw_deg=0)
    text("Logo_Wall_Title", "WATCHLIST", (-W / 2 + 0.03, 0, 2.6), 0.2, P["label"], col, yaw_deg=90)
    # lukisan pixel art
    painting("Painting_To_The_Moon", "To_The_Moon", (2.35, D / 2 - 0.02, 1.35), (1.6, 1.2), col)
    painting("Painting_Sunset_Peaks", "Sunset_Peaks", (7.85, D / 2 - 0.02, 1.35), (1.6, 1.2), col)
    painting("Banner_HODL", "HODL", (-0.15, D / 2 - 0.02, 2.4), (1.3, 0.57), col, frame_hex="#2D3138", emit=1.2)
    # hologram koin berputar
    coin_hologram("Holo_BTC", (TABLE_C.x, -4.25), col, "BTC")
    coin_hologram("Holo_ETH", (CORRIDOR_X, -4.25), col, "ETH")


# -------------------------------------------------------- kamera & render

def iso_camera(scene, name, target, ortho, yaw=45.0, pitch=60.0):
    cd = bpy.data.cameras.new(name)
    cd.type = "ORTHO"
    cd.ortho_scale = ortho
    cd.clip_end = 300
    cam = bpy.data.objects.new(name, cd)
    scene.collection.objects.link(cam)
    p, y = math.radians(pitch), math.radians(yaw)
    view = Vector((-math.sin(y) * math.sin(p), math.cos(y) * math.sin(p), -math.cos(p)))
    cam.location = Vector(target) - view * 60
    cam.rotation_euler = (p, 0, y)
    scene.camera = cam
    return cam


def lights_and_world(scene, args, strength=0.85):
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(10)
    sun.rotation_euler = (math.radians(42), math.radians(8), math.radians(25))
    scene.collection.objects.link(sun)
    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", "AREA"))
    fill.data.energy = 2500
    fill.data.size = 14
    fill.location = (8, -12, 12)
    fill.rotation_euler = (math.radians(45), 0, math.radians(35))
    scene.collection.objects.link(fill)
    world = bpy.data.worlds.new(f"{scene.name}_World")
    scene.world = world
    if bpy.app.version < (5, 0):
        world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = hex_rgba("#CDD5DF")
    bg.inputs["Strength"].default_value = strength
    rx, ry = (int(v) for v in args.res.lower().split("x"))
    scene.render.resolution_x, scene.render.resolution_y = rx, ry
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"


def build_lineup(data, rigs, args):
    """Scene terpisah: 9 karakter berjajar dengan nama & peran."""
    sc = bpy.data.scenes.new("Character_Lineup")
    col = bpy.data.collections.new("Lineup")
    sc.collection.children.link(col)
    P = palette()
    box("Lineup_Floor", (14, 6, 0.1), (0, 1.2, -0.1), mat("#E3E7EC", 0.8), col, bevel=0)
    box("Lineup_Wall", (14, 0.1, 5), (0, 3.0, -0.1), mat("#DCE2E9", 0.8), col, bevel=0)
    n = len(rigs)
    for i, (agent, rig) in enumerate(zip(data["agents"], rigs)):
        x = (i - (n - 1) / 2) * 1.3
        r = rig.copy()
        r.animation_data_clear()
        r.location = (x, 0, 0)
        r.rotation_euler = (0, 0, 0)
        col.objects.link(r)
        body = bpy.data.objects[f"{agent['id']}_body"].copy()
        body.parent = r
        body.modifiers["Armature"].object = r
        col.objects.link(body)
        pose = pose_stand(0)
        pose["arm.R"] = -0.25 if i % 2 else 0.15
        pose["arm.L"] = 0.15 if i % 2 else -0.2
        if agent["camp"] == "moderator":
            pose["arm.R"] = -2.6   # melambai
        apply_pose(r, pose)
        box(f"Lineup_{agent['id']}_plaque", (1.15, 0.12, 0.42), (x, -0.6, 0), P["black"], col, bevel=0.02)
        text(f"Lineup_{agent['id']}", agent["id"], (x, -0.67, 0.2), 0.16,
             mat(label_color(agent["look"]), 0.4, emit=1.5), col, yaw_deg=0)
        text(f"Lineup_{agent['id']}_role", agent["role"].upper(), (x, -0.67, 0.07), 0.075,
             P["white"], col, yaw_deg=0)
    text("Lineup_Title", f"{data['office']['name']}  AGENTS", (0, 2.9, 3.0), 0.42,
         mat("#1E2A3A", 0.5), col, yaw_deg=0)
    iso_camera(sc, "Lineup_Camera", (0, 0, 1.2), 12.5, yaw=0.0, pitch=78.0)
    lights_and_world(sc, args, strength=1.0)
    sc.render.resolution_y = int(sc.render.resolution_x * 0.5)
    return sc


# -------------------------------------------------------------------- main

def main():
    args = parse_args()
    with open(args.data, encoding="utf-8") as f:
        data = json.load(f)
    clear_all()
    scene = bpy.context.scene
    scene.name = data["office"]["name"]
    P = palette()
    build_office(data, P)
    build_meeting_room(data, P)
    build_decor(P)
    agents = data["agents"]
    by_id = {a["id"]: a for a in agents}

    # meja + karakter
    char_col = collection("Agents")
    desks, rigs = {}, []
    for i, a in enumerate(agents):
        x, y = DESK_COLS[i % 3], DESK_ROWS[i // 3]
        desks[a["id"]] = Vector((x, y))
        build_desk(a, x, y, P, collection("Desks"))
        rigs.append(build_rig(a, char_col))
    make_library_actions(rigs[0])

    # rencana berjalan ke Meeting Room
    seats = meeting_seats(agents)
    for aid, (pos, yaw, _) in seats.items():
        build_chair(f"MR_Chair_{aid}", pos, math.degrees(yaw), by_id[aid]["look"]["top"], P,
                    collection("Meeting_Room"))
    routes = {}
    for aid, desk in desks.items():
        seat, yaw, inner = seats[aid]
        aisle_y = desk.y + 0.95
        path = [Vector((desk.x + 1.25, desk.y)), Vector((desk.x + 1.25, aisle_y)),
                Vector((CORRIDOR_X, aisle_y)), Vector((CORRIDOR_X, DOOR_Y)),
                Vector((MEET_X0 + 0.6, DOOR_Y))] + inner
        routes[aid] = (path, seat, yaw)
    order = sorted(routes, key=lambda k: polyline([desks[k]] + routes[k][0] + [routes[k][1]])[1])
    chatter_end = max(c["frame"] for c in data["desk_chatter"]) + 50
    plans = {}
    for k, aid in enumerate(order):
        path, seat, yaw = routes[aid]
        plans[aid] = Plan(aid, desks[aid], path, seat, yaw, chatter_end + k * 10)

    # jadwal bicara: obrolan di meja, lalu debat bergiliran
    speeches = []
    for i, c in enumerate(data["desk_chatter"]):
        speeches.append((c["agent"], c["frame"], c["frame"] + 46, c["text"]))
    f = max(p.f_seated for p in plans.values()) + 16
    for line in data["debate"]:
        speeches.append((line["agent"], f, f + MSG_F, line["text"]))
        f += MSG_F + MSG_GAP
    frame_end = f + 24

    debate_start = speeches[len(data["desk_chatter"])][1]
    debate_cam = iso_camera(scene, "Debate_Camera", (TABLE_C.x, TABLE_C.y, 1.4), 9.5)
    cam = iso_camera(scene, "Iso_Camera", (0.3, -0.3, 0.9), 21.5)
    # kamera berganti otomatis lewat timeline marker
    for f_mark, c in ((1, cam), (debate_start - 8, debate_cam)):
        scene.timeline_markers.new(c.name, frame=f_mark).camera = c
    lights_and_world(scene, args)
    scene.frame_start, scene.frame_end = 1, frame_end
    scene.render.fps = data["office"].get("fps", 24)

    bubble_col = collection("Chat_Bubbles")
    rig_by_id = {r.name: r for r in rigs}
    for n, (aid, f0, f1, msg) in enumerate(speeches):
        root = make_bubble(f"Bubble_{n:02d}_{aid}", aid, msg, by_id[aid]["look"]["top"], bubble_col, cam)
        attach_bubble(root, rig_by_id[aid], f0, f1)
    # template untuk dipakai ulang (collection disembunyikan)
    tpl_col = collection("QB_Assets")
    make_bubble("ChatBubble_Template", "AGENT", "Tulis pesan di sini...", "#35C9FF", tpl_col, cam)
    bpy.context.view_layer.layer_collection.children["QB_Assets"].exclude = True

    for rig in rigs:
        bake(rig, plans[rig.name], plans, speeches, frame_end)

    print(f"[quantbot] {len(rigs)} agen, {len(speeches)} chat bubble, frame 1-{frame_end}")
    for aid in order:
        p = plans[aid]
        print(f"  {aid:6s} berdiri f{p.f_stand}, tiba f{p.f_arrive}, duduk f{p.f_seated}")
    print(f"  debat mulai f{debate_start}")

    lineup = build_lineup(data, rigs, args)
    if args.save:
        scene.frame_set(1)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save), compress=True)
        print(f"[quantbot] disimpan: {args.save}")
    for path, frame in zip(args.render, args.frame + [1] * len(args.render)):
        scene.frame_set(frame)
        marks = [m for m in scene.timeline_markers if m.frame <= frame and m.camera]
        if marks:
            scene.camera = max(marks, key=lambda m: m.frame).camera
        scene.render.filepath = os.path.abspath(path)
        bpy.ops.render.render(write_still=True, scene=scene.name)
        print(f"[quantbot] render f{frame}: {path}")
    if args.render_lineup:
        lineup.render.filepath = os.path.abspath(args.render_lineup)
        bpy.ops.render.render(write_still=True, scene=lineup.name)
        print(f"[quantbot] render lineup: {args.render_lineup}")


if __name__ == "__main__":
    main()
