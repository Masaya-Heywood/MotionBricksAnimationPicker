"""Blender script: builds two small synthetic Mixamo-named humanoid clips (cm, Z-up) so the tests do not need
any commercial asset pack.

    blender -b --factory-startup --python make_fixtures.py -- <out_dir>
"""
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

out_dir = sys.argv[sys.argv.index("--") + 1]
os.makedirs(out_dir, exist_ok=True)

P = "mixamorig:"
# name, parent, head, tail  (cm, Z up, character faces -Y, left = +X)
BONES = [
    ("Hips", None, (0, 0, 98), (0, 0, 108)),
    ("Spine", "Hips", (0, 0, 108), (0, 0, 118)),
    ("Spine1", "Spine", (0, 0, 118), (0, 0, 128)),
    ("Spine2", "Spine1", (0, 0, 128), (0, 0, 145)),
    ("Neck", "Spine2", (0, 0, 145), (0, 0, 155)),
    ("Head", "Neck", (0, 0, 155), (0, 0, 172)),
]
for side, sx in (("Left", 1), ("Right", -1)):
    BONES += [
        (side + "Shoulder", "Spine2", (sx * 3, 0, 142), (sx * 12, 0, 142)),
        (side + "Arm", side + "Shoulder", (sx * 12, 0, 142), (sx * 38, 0, 142)),
        (side + "ForeArm", side + "Arm", (sx * 38, 0, 142), (sx * 62, 0, 142)),
        (side + "Hand", side + "ForeArm", (sx * 62, 0, 142), (sx * 72, 0, 142)),
        (side + "UpLeg", "Hips", (sx * 9, 0, 95), (sx * 9, 0, 52)),
        (side + "Leg", side + "UpLeg", (sx * 9, 0, 52), (sx * 9, 0, 10)),
        (side + "Foot", side + "Leg", (sx * 9, 0, 10), (sx * 9, -12, 3)),
        (side + "ToeBase", side + "Foot", (sx * 9, -12, 3), (sx * 9, -20, 3)),
    ]


def build(clip_name, phase, hip_travel, reach):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, head, tail in BONES:
        eb = arm_data.edit_bones.new(P + name)
        eb.head, eb.tail = Vector(head), Vector(tail)
        if parent:
            eb.parent = arm_data.edit_bones[P + parent]
    bpy.ops.object.mode_set(mode="POSE")
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = "XYZ"
    n = 31
    scene.frame_start, scene.frame_end = 0, n - 1
    def values(f):
        t = f / (n - 1.0) * 2 * math.pi
        v = {"Hips": ((0, -hip_travel * f / (n - 1.0), 2.0 * math.sin(2 * t + phase)), (0, 0, 0.15 * math.sin(t + phase))),
             "Spine1": ((0, 0, 0), (0.08 * math.sin(t), 0, -0.1 * math.sin(t + phase)))}
        for side, s in (("Left", 1), ("Right", -1)):
            v[side + "Arm"] = ((0, 0, 0), (0, 0, 0.6 * s * math.sin(t + phase) + reach * s * f / (n - 1.0)))
            v[side + "ForeArm"] = ((0, 0, 0), (0, 0, 0.5 * s * (1 + math.sin(t + phase)) / 2))
            v[side + "UpLeg"] = ((0, 0, 0), (0.5 * s * math.sin(t + phase), 0, 0))
            v[side + "Leg"] = ((0, 0, 0), (0.4 * (1 + math.sin(t + phase + s)) / 2, 0, 0))
        return v

    v0 = values(0)  # key relative to frame 0 so the first frame is exactly the rest (T) pose
    for f in range(n):
        v = values(f)
        for name, (loc, eul) in v.items():
            b = pb[P + name]
            b.location = Vector([loc[i] - v0[name][0][i] for i in range(3)])
            b.rotation_euler = Euler([eul[i] - v0[name][1][i] for i in range(3)])
            b.keyframe_insert("location", frame=f)
            b.keyframe_insert("rotation_euler", frame=f)
    scene.frame_set(0)
    bpy.ops.object.mode_set(mode="OBJECT")
    scene.name = clip_name
    path = os.path.join(out_dir, "Synth@%s.fbx" % clip_name)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.ops.export_scene.fbx(filepath=path, use_selection=True, object_types={"ARMATURE"}, add_leaf_bones=False,
                             bake_anim=True, bake_anim_use_all_bones=True, bake_anim_use_nla_strips=False,
                             bake_anim_use_all_actions=False, bake_anim_simplify_factor=0.0)
    print("[fixture] wrote", path)


build("WalkA", 0.0, 60.0, 0.0)
build("Reach", 1.3, 20.0, 0.9)
