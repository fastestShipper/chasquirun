# Chasqui Run asset kit: Inca masonry, authored in Blender, exported as GLB.
#
# WHY THIS EXISTS
# The game's structures are trapezoid boxes wearing a stone texture. That has a
# hard ceiling: masonry reads as masonry because of per-stone SILHOUETTE, chipped
# edges and real depth in the joints, none of which a flat face can fake. At the
# distances the player sees a gateway (they run through it every chunk) the
# texture trick falls apart.
#
# So the stones here are actual geometry. Each block is an individually shaped,
# bevelled solid with jittered dimensions, set into a course with real recessed
# joints. That is what sells Sacsayhuaman-style polygonal masonry.
#
# Everything is merged per piece before export, so a whole wall is ONE mesh and
# one draw call. The game is already near its draw call budget, so a kit that
# shipped one mesh per stone would be unusable no matter how good it looked.
#
# Run headless:
#   blender -b --factory-startup -noaudio -P tools/kit_masonry.py -- <outdir>

import bpy
import bmesh
import math
import os
import random
import sys

# Deterministic: the same kit every run, so a rebuild never silently changes
# the game's look.
SEED = 20260719


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def new_mesh(name):
    me = bpy.data.meshes.new(name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def bm_block(bm, x, y, z, w, h, d, rng, bevel=0.022, jitter=0.012):
    """One masonry block: a box with jittered corners and bevelled edges.

    The corner jitter is what stops a course reading as repeated cubes. It is
    small (about a centimetre) because Inca ashlar is TIGHT; the irregularity
    should read as hand-cut stone, not as rubble.
    """
    verts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                jx = rng.uniform(-jitter, jitter)
                jy = rng.uniform(-jitter, jitter)
                jz = rng.uniform(-jitter, jitter)
                # Faces bulge very slightly outward: real cut stone is never
                # perfectly planar and the highlight break is what catches light.
                # x = along the wall, y = thickness, z = HEIGHT (Blender is
                # Z-up; the exporter converts to Y-up for three.js).
                verts.append(bm.verts.new((
                    x + sx * (w / 2 + jx),
                    y + sy * (d / 2 + jy),
                    z + sz * (h / 2 + jz),
                )))
    bm.verts.ensure_lookup_table()
    v = verts
    faces = [
        (0, 1, 3, 2), (4, 6, 7, 5),
        (0, 4, 5, 1), (2, 3, 7, 6),
        (0, 2, 6, 4), (1, 5, 7, 3),
    ]
    made = []
    for f in faces:
        try:
            made.append(bm.faces.new([v[i] for i in f]))
        except ValueError:
            pass
    if bevel > 0 and made:
        edges = set()
        for f in made:
            for e in f.edges:
                edges.add(e)
        bmesh.ops.bevel(
            bm, geom=list(edges), offset=bevel, segments=1,
            profile=0.62, affect='EDGES', clamp_overlap=True,
        )
    return made


def polygonal_wall(name, length, height, thickness, rng, courses=None):
    """Sacsayhuaman-flavoured wall: courses of large fitted blocks.

    Course heights vary and block widths vary within a course, with each course
    offset so vertical joints never line up. That break-up is the single most
    recognisable property of Inca stonework.
    """
    ob = new_mesh(name)
    bm = bmesh.new()

    if courses is None:
        courses = max(3, int(height / 0.46))
    # Course heights sum to exactly `height` so pieces stack seamlessly.
    raw = [rng.uniform(0.75, 1.35) for _ in range(courses)]
    s = sum(raw)
    hs = [r / s * height for r in raw]

    y = 0.0
    for ci, ch in enumerate(hs):
        # Bigger stones at the bottom, the way a real load-bearing wall is built.
        depth_bias = 1.0 - 0.25 * (y / max(height, 0.001))
        x = -length / 2
        # Offset the start of each course so joints stagger.
        x += rng.uniform(0.0, 0.35) * (1 if ci % 2 else -1)
        while x < length / 2 - 0.05:
            bw = rng.uniform(0.34, 0.86) * depth_bias
            bw = min(bw, length / 2 - x)
            if bw < 0.12:
                break
            # Joint gap: the recess between stones. This is a real gap in the
            # geometry, which is why it survives at any viewing angle.
            gap = rng.uniform(0.012, 0.026)
            cx = x + bw / 2
            cz = y + ch / 2          # `y` is the running height cursor
            # A slight inward batter, the classic Inca lean.
            batter = (y / max(height, 0.001)) * thickness * 0.14
            bm_block(
                bm, cx, 0.0, cz,
                bw - gap, ch - gap, thickness - batter,
                rng, bevel=min(0.035, ch * 0.16), jitter=0.022,
            )
            x += bw
        y += ch

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def portada(name, rng):
    """The trapezoidal gateway the player runs through every chunk.

    Trapezoid discipline is the strongest Inca signature: the opening tapers
    inward toward the top. Double jamb, heavy monolithic lintel.
    """
    ob_parts = []
    W = 9.4          # outer width; jambs must be wide enough to show coursing
    OPEN_B = 4.4     # opening width at the base
    OPEN_T = 3.5     # narrower at the top: the taper
    H = 4.6
    TH = 1.0

    for side in (-1, 1):
        # Each jamb is a wall whose inner face leans in with height.
        jw = (W - OPEN_B) / 2
        j = polygonal_wall(f"{name}_jamb{'L' if side < 0 else 'R'}",
                           jw, H, TH, rng, courses=10)
        j.location = (side * (OPEN_B + jw) / 2, 0, 0)
        # Shear the jamb so the opening narrows toward the top (z is height).
        lean = (OPEN_B - OPEN_T) / 2 / H
        me = j.data
        for v in me.vertices:
            v.co.x += -side * lean * v.co.z
        ob_parts.append(j)

    # Lintel: one massive stone spanning the opening.
    lin = new_mesh(f"{name}_lintel")
    bm = bmesh.new()
    bm_block(bm, 0, 0, 0, OPEN_T + 2.4, 0.72, TH * 1.16, rng, bevel=0.07, jitter=0.035)
    # (w along x, h in z, d in y: the block helper takes w, h, d)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(lin.data)
    bm.free()
    lin.location = (0, 0, H + 0.39)
    ob_parts.append(lin)

    return ob_parts


def join_and_finalize(parts, name):
    """Merge to one object: a kit piece must cost one draw call, not fifty."""
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name

    # Apply transforms so the exported geometry needs no runtime fixup.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Weld coincident verts, then shade flat: this is faceted stone, and flat
    # shading is what makes each block's facets catch the light separately.
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0008)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = False

    # UVs so the game's stone texture has something to sample.
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.cube_project(cube_size=1.0)
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def export(ob, outdir, filename):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    path = os.path.join(outdir, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_apply=True,
        export_yup=True,          # three.js is Y-up
        export_normals=True,
        export_texcoords=True,
        export_materials='NONE',  # the game assigns its own curvature-patched mats
        export_cameras=False,
        export_lights=False,
    )
    n = len(ob.data.polygons)
    size = os.path.getsize(path) if os.path.exists(path) else -1
    print(f"KIT_OK {filename} tris~{n} bytes={size}")
    return path


def build_all(outdir):
    os.makedirs(outdir, exist_ok=True)
    specs = []

    # --- the gateway the player runs through -------------------------------
    reset()
    rng = random.Random(SEED)
    parts = portada("portada", rng)
    ob = join_and_finalize(parts, "portada")
    specs.append(export(ob, outdir, "portada.glb"))

    # --- wall runs, sized to tile along the 36 m chunk ---------------------
    for ln, tag in ((9.0, "9m"), (4.5, "4m5")):
        reset()
        rng = random.Random(SEED + int(ln * 10))
        w = polygonal_wall(f"wall_{tag}", ln, 2.4, 0.62, rng)
        ob = join_and_finalize([w], f"wall_{tag}")
        specs.append(export(ob, outdir, f"wall_{tag}.glb"))

    # --- a low terrace-style retaining course ------------------------------
    reset()
    rng = random.Random(SEED + 77)
    w = polygonal_wall("wall_low_9m", 9.0, 1.15, 0.55, rng, courses=3)
    ob = join_and_finalize([w], "wall_low_9m")
    specs.append(export(ob, outdir, "wall_low_9m.glb"))

    print("KIT_DONE", len(specs))


if __name__ == "__main__":
    argv = sys.argv
    outdir = argv[-1] if "--" in argv else "assets/kit"
    build_all(outdir)
