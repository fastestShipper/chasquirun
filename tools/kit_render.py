# Render a kit GLB to a PNG so the asset can be judged without the game.
#
# Verification without stealing the machine: the question "does this masonry
# actually read as Inca stonework" is about the ASSET, so it can be answered in
# Blender. Three-quarter view, soft key light, plain background.
#
#   blender -b --factory-startup -noaudio -P tools/kit_render.py -- <glb> <png>

import bpy
import math
import os
import sys


def look_at(obj, target):
    import mathutils
    d = mathutils.Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()


def main(glb, png):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)

    # Fit the camera to whatever came in.
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objs:
        print("RENDER_FAIL no mesh")
        return
    minv = [1e9] * 3
    maxv = [-1e9] * 3
    tris = 0
    for o in objs:
        tris += len(o.data.polygons)
        for c in o.bound_box:
            w = o.matrix_world @ __import__('mathutils').Vector(c)
            for i in range(3):
                minv[i] = min(minv[i], w[i])
                maxv[i] = max(maxv[i], w[i])
    ctr = [(minv[i] + maxv[i]) / 2 for i in range(3)]
    size = max(maxv[i] - minv[i] for i in range(3))

    # Stone material so the shape reads, rather than default grey plastic.
    mat = bpy.data.materials.new("stone")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.44, 0.42, 0.39, 1)
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.85
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)

    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    # Mostly frontal, slightly off-axis and near eye height. This is roughly
    # how the player meets a gateway, and it is the angle that judges the FACE.
    # A high three-quarter shot mostly shows the top of the wall, which is not
    # the surface anyone looks at in game.
    cam.location = (ctr[0] + size * 0.42, ctr[1] - size * 1.05, ctr[2] + size * 0.22)
    look_at(cam, ctr)
    bpy.context.scene.camera = cam

    key = bpy.data.objects.new("key", bpy.data.lights.new("key", 'SUN'))
    bpy.context.collection.objects.link(key)
    key.data.energy = 4.0
    key.rotation_euler = (math.radians(52), 0, math.radians(38))

    fill = bpy.data.objects.new("fill", bpy.data.lights.new("fill", 'SUN'))
    bpy.context.collection.objects.link(fill)
    fill.data.energy = 1.1
    fill.rotation_euler = (math.radians(66), 0, math.radians(-125))

    w = bpy.context.scene.world or bpy.data.worlds.new("w")
    bpy.context.scene.world = w
    w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.42, 0.53, 0.68, 1)
        bg.inputs[1].default_value = 0.7

    sc = bpy.context.scene
    # Engine id changed across versions; try modern first, fall back.
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
        try:
            sc.render.engine = eng
            break
        except TypeError:
            continue
    try:
        sc.eevee.taa_render_samples = 32
    except Exception:
        pass
    sc.render.resolution_x = 900
    sc.render.resolution_y = 700
    sc.render.filepath = png
    sc.render.image_settings.file_format = 'PNG'
    bpy.ops.render.render(write_still=True)
    print(f"RENDER_OK {os.path.basename(glb)} tris={tris} -> {png}")


if __name__ == "__main__":
    a = sys.argv[sys.argv.index("--") + 1:]
    main(a[0], a[1])
