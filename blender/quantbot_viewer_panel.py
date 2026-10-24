"""
Panel "QUANTBOT" di sidebar viewport (tekan N di 3D Viewport).

- Tombol ruangan: pindah kamera ke ruangan tsb dan menyembunyikan lantai yang
  menghalangi (mis. lantai 2 disembunyikan saat melihat Trading Floor).
- Zoom: slider yang langsung mengubah ortho scale kamera aktif.
- Lantai: centang untuk tampil/sembunyi Exterior, Floor_1, Floor_2, Roof.
- Play / Pause animasi.

Script ini tersimpan di dalam quantbot_hq.blend sebagai text block yang
didaftarkan otomatis saat file dibuka (izinkan "Auto Run Python Scripts" atau
buka Text Editor lalu tekan Run Script).
"""

import json

import bpy

TOGGLES = ("Exterior", "Floor_1", "Floor_2", "Roof", "Facade_1", "Facade_2")
TOGGLE_LABELS = {"Exterior": "Eksterior", "Floor_1": "Lantai 1", "Floor_2": "Lantai 2", "Roof": "Atap",
                 "Facade_1": "Kaca fasad lantai 1", "Facade_2": "Kaca fasad lantai 2"}
LABELS = {
    "CAM_Overview": "Overview + Eksterior", "CAM_Exterior": "Eksterior (perspektif)",
    "CAM_Building": "Gedung", "CAM_Floor1": "Lantai 1", "CAM_TradingFloor": "Trading Floor",
    "CAM_MeetingRoom": "Meeting Room", "CAM_Pantry": "Pantry", "CAM_Floor2": "Lantai 2",
    "CAM_LeadRooms": "Ruang Lead", "CAM_OwnerRoom": "Ruang Owner (DJ)", "CAM_GameRoom": "Game Room",
}


def _views(scene):
    try:
        return json.loads(scene.get("qb_views", "{}"))
    except ValueError:
        return {}


def _set_zoom(self, context):
    cam = context.scene.camera
    if cam and cam.type == "CAMERA":
        base = cam.get("base_ortho", cam.data.ortho_scale)
        if cam.data.type == "ORTHO":
            cam.data.ortho_scale = base / max(0.05, self.qb_zoom)
        else:
            cam.data.lens = 32 * self.qb_zoom


def _toggle_getter(name):
    def get(self):
        c = bpy.data.collections.get(name)
        return bool(c) and not c.hide_viewport
    return get


def _toggle_setter(name):
    def set_(self, value):
        c = bpy.data.collections.get(name)
        if c:
            c.hide_viewport = not value
            c.hide_render = not value
    return set_


class QB_OT_view(bpy.types.Operator):
    bl_idname = "quantbot.view"
    bl_label = "Lihat ruangan"
    bl_options = {"REGISTER", "UNDO"}
    view: bpy.props.StringProperty()

    def execute(self, context):
        scene = context.scene
        v = _views(scene).get(self.view)
        if not v:
            return {"CANCELLED"}
        scene.camera = bpy.data.objects[v["camera"]]
        for name in TOGGLES:
            c = bpy.data.collections.get(name)
            if c:
                c.hide_viewport = c.hide_render = name in v["hide"]
        scene.qb_zoom = 1.0
        for area in context.screen.areas:
            if area.type == "VIEW_3D":
                area.spaces.active.region_3d.view_perspective = "CAMERA"
        return {"FINISHED"}


class QB_OT_play(bpy.types.Operator):
    bl_idname = "quantbot.play"
    bl_label = "Play / Pause"

    def execute(self, context):
        bpy.ops.screen.animation_play()
        return {"FINISHED"}


class QB_PT_panel(bpy.types.Panel):
    bl_label = "QUANTBOT HQ"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "QUANTBOT"

    def draw(self, context):
        scene = context.scene
        lay = self.layout
        row = lay.row(align=True)
        row.operator("quantbot.play", icon="PLAY")
        row.label(text=f"Frame {scene.frame_current}")
        lay.prop(scene, "qb_zoom", slider=True)
        box = lay.box()
        box.label(text="Tampilkan")
        for name in TOGGLES:
            box.prop(scene, f"qb_show_{name}", text=TOGGLE_LABELS.get(name, name))
        views = _views(scene)
        box = lay.box()
        box.label(text="Ruangan")
        col = box.column(align=True)
        for name in views:
            if name.startswith("CAM_Lead_"):
                continue
            col.operator("quantbot.view", text=LABELS.get(name, name)).view = name
        box = lay.box()
        box.label(text="Ruang Lead")
        grid = box.grid_flow(columns=3, align=True)
        for name in views:
            if name.startswith("CAM_Lead_"):
                grid.operator("quantbot.view", text=name[9:]).view = name


CLASSES = (QB_OT_view, QB_OT_play, QB_PT_panel)


def register():
    for cls in CLASSES:
        try:
            bpy.utils.register_class(cls)
        except ValueError:
            bpy.utils.unregister_class(cls)
            bpy.utils.register_class(cls)
    bpy.types.Scene.qb_zoom = bpy.props.FloatProperty(
        name="Zoom", default=1.0, min=0.25, max=6.0, update=_set_zoom)
    for name in TOGGLES:
        setattr(bpy.types.Scene, f"qb_show_{name}", bpy.props.BoolProperty(
            name=name.replace("_", " "), get=_toggle_getter(name), set=_toggle_setter(name)))


def unregister():
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
