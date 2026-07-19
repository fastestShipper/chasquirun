# Chasqui Run asset kit: Inca polygonal masonry, authored in Blender, as GLB.
#
# WHY THIS EXISTS
# The game's structures are trapezoid boxes wearing a stone texture. That has a
# hard ceiling: masonry reads as masonry because of per-stone SILHOUETTE and
# real depth in the joints, neither of which a flat face can fake at the range
# the player runs through a gateway every chunk.
#
# WHY A LATTICE AND NOT COURSES OF BRICKS
# The first version stacked jittered boxes in rows. It read as BRICKWORK, which
# is the opposite of the reference: Sacsayhuaman-style stonework is interlocking
# and polygonal, with many-sided stones that fit each other exactly and joints
# that wander instead of running straight.
#
# So the wall face is a jittered lattice whose corner points are SHARED between
# neighbouring cells. Because neighbours share their corners, the stones
# interlock exactly by construction: no gaps, no overlaps, and every joint is a
# real recess in the geometry rather than a painted line. Cells are randomly
# fused with a neighbour to produce the big multi-sided stones the style is
# known for.
#
# Everything is merged per piece before export, so a whole wall is ONE mesh and
# one draw call. The game is already near its draw call budget, so a kit that
# shipped one mesh per stone would be unusable no matter how good it looked.
#
# Run headless:
#   blender -b --factory-startup -noaudio -P tools/kit_masonry.py -- <outdir>
#
# Authoring is in Blender's NATIVE Z-up (x along the wall, y thickness,
# z height). The exporter converts to three.js Y-up exactly once.

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


def lattice_cells(length, height, rng, target=0.62):
    """Interlocking polygonal cells covering a length x height face.

    Returns a list of cells, each a list of (x, z) points in winding order.
    Corner points are shared between neighbours, so the cells tile the face
    exactly: that shared-corner property is the whole trick.
    """
    nx = max(2, int(round(length / target)))
    nz = max(2, int(round(height / target)))
    cw = length / nx
    ch = height / nz

    # Lattice points, jittered. Points ON the outer boundary are only jittered
    # ALONG that boundary, so the silhouette of the piece stays straight and
    # walls still butt together cleanly when placed end to end.
    pts = {}
    for i in range(nx + 1):
        for j in range(nz + 1):
            jx = 0.0 if i in (0, nx) else rng.uniform(-0.33, 0.33) * cw
            jz = 0.0 if j in (0, nz) else rng.uniform(-0.33, 0.33) * ch
            pts[(i, j)] = (length * i / nx + jx, height * j / nz + jz)

    taken = set()
    cells = []
    for j in range(nz):
        for i in range(nx):
            if (i, j) in taken:
                continue
            # Fuse with a neighbour sometimes: this is what produces the large
            # many-sided stones instead of a uniform field of quads.
            wide = (i + 1 < nx and (i + 1, j) not in taken and rng.random() < 0.30)
            tall = (not wide and j + 1 < nz
                    and (i, j + 1) not in taken and rng.random() < 0.22)
            if wide:
                taken.add((i, j)); taken.add((i + 1, j))
                # Include the mid-edge points so the fused stone is genuinely
                # 6-sided, not a plain rectangle spanning two cells.
                poly = [pts[(i, j)], pts[(i + 1, j)], pts[(i + 2, j)],
                        pts[(i + 2, j + 1)], pts[(i + 1, j + 1)], pts[(i, j + 1)]]
            elif tall:
                taken.add((i, j)); taken.add((i, j + 1))
                poly = [pts[(i, j)], pts[(i + 1, j)], pts[(i + 1, j + 1)],
                        pts[(i + 1, j + 2)], pts[(i, j + 2)], pts[(i, j + 1)]]
            else:
                taken.add((i, j))
                poly = [pts[(i, j)], pts[(i + 1, j)],
                        pts[(i + 1, j + 1)], pts[(i, j + 1)]]
            cells.append(poly)
    return cells


def inset(poly, amount):
    """Shrink a polygon toward its centroid. This gap IS the joint."""
    n = len(poly)
    cx = sum(p[0] for p in poly) / n
    cz = sum(p[1] for p in poly) / n
    out = []
    for (x, z) in poly:
        dx, dz = x - cx, z - cz
        d = math.hypot(dx, dz)
        if d < 1e-6:
            return []
        k = max(0.15, d - amount) / d
        out.append((cx + dx * k, cz + dz * k))
    return out


def stone(bm, poly, half_depth, rng, bulge=0.035):
    """Extrude one polygonal cell into a stone with a domed, tilted face.

    Two things sell hand-cut stone and neither is the outline:

    The DOME, because real cut stone is never planar, so each block carries its
    own highlight instead of the wall reading as one flat plane.

    The TILT, because no two stones were dressed to exactly the same plane. A
    couple of degrees of random lean is what makes raking light break unevenly
    across the face, and it does more work than the silhouette does.
    """
    n = len(poly)
    cx = sum(p[0] for p in poly) / n
    cz = sum(p[1] for p in poly) / n
    # Radius of this stone, so small stones are not proportionally more bulbous.
    rad = max(math.hypot(x - cx, z - cz) for (x, z) in poly) or 1.0

    tilt_x = rng.uniform(-0.055, 0.055)
    tilt_z = rng.uniform(-0.055, 0.055)

    def face_y(x, z):
        d = math.hypot(x - cx, z - cz) / rad
        dome = bulge * max(0.0, 1.0 - d * d)
        lean = tilt_x * (x - cx) + tilt_z * (z - cz)
        return -half_depth - dome - lean

    back = [bm.verts.new((x, half_depth, z)) for (x, z) in poly]
    front = [bm.verts.new((x, face_y(x, z) + rng.uniform(-0.006, 0.006), z))
             for (x, z) in poly]

    # A centre vertex pushed proudest: gives the face a real dome rather than a
    # flat cap, and keeps the n-gon triangulating cleanly.
    apex = bm.verts.new((cx, face_y(cx, cz), cz))

    try:
        bm.faces.new(list(reversed(back)))
    except ValueError:
        pass
    for i in range(n):
        a, b2 = i, (i + 1) % n
        try:
            bm.faces.new([front[a], front[b2], apex])
        except ValueError:
            pass
        try:
            bm.faces.new([front[a], front[b2], back[b2], back[a]])
        except ValueError:
            pass


def backing_slab(bm, length, height, y0, y1):
    """Solid plate behind the stones, so joints are RECESSES and not holes.

    Each stone is its own closed solid, so without this the joint gaps run
    clean through the wall and the player sees the landscape through the
    masonry. The slab sits behind every stone's rear face and costs 6 faces.
    """
    x0, x1 = -length / 2, length / 2
    z0, z1 = 0.0, height
    c = [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1),
         (x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)]
    v = [bm.verts.new(p) for p in c]
    for f in ((0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1),
              (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
        try:
            bm.faces.new([v[i] for i in f])
        except ValueError:
            pass


def polygonal_wall(name, length, height, thickness, rng, joint=0.05, target=0.62):
    ob = new_mesh(name)
    bm = bmesh.new()
    # Behind the rear face of the shallowest stone (0.80 * thickness / 2).
    backing_slab(bm, length, height, thickness * 0.30, thickness * 0.52)
    for poly in lattice_cells(length, height, rng, target=target):
        p = inset(poly, joint)
        if len(p) < 3:
            continue
        # Stones sit proud of each other by a few centimetres. Without this the
        # face is one plane with scratches on it; with it the joints cast real
        # shadow and the wall has depth from any angle.
        d = thickness * rng.uniform(0.80, 1.06)
        stone(bm, [(x - length / 2, z) for (x, z) in p], d / 2, rng)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(ob.data)
    bm.free()
    return ob


def portada(name, rng):
    """The trapezoidal gateway the player runs through every chunk.

    Trapezoid discipline is the strongest Inca signature: the opening tapers
    inward toward the top. Double jamb, heavy monolithic lintel.

    CLEARANCE CONTRACT (mirrors buildGateway in src/scenery.js): the opening
    must stay clear for x in [-3.4, 3.4] below y 3.2. Lanes sit at x = -2.2, 0
    and +2.2, so a narrower opening puts a jamb on top of an outer lane and the
    player simply cannot pass. These numbers are gameplay, not decoration: do
    not shrink them to make the piece look chunkier.
    """
    parts = []
    INNER_B = 4.1    # half opening at grade
    INNER_T = 3.45   # half opening under the lintel
    JW = 1.7         # jamb width in x
    H = 3.9          # underside of the lintel
    TH = 1.4         # jamb thickness (z in game, y here)

    for side in (-1, 1):
        j = polygonal_wall(f"{name}_jamb{'L' if side < 0 else 'R'}",
                           JW, H, TH, rng)
        j.location = (side * (INNER_B + JW / 2), 0, 0)
        # Shear so the opening narrows toward the top (z is height).
        lean = (INNER_B - INNER_T) / H
        for v in j.data.vertices:
            v.co.x += -side * lean * v.co.z
        parts.append(j)

    # Lintel: a run of very large stones spanning the whole opening.
    lin = polygonal_wall(f"{name}_lintel", 10.7, 0.9, TH * 1.14,
                         rng, joint=0.055, target=1.15)
    # polygonal_wall builds upward from z=0, so the lintel must be seated at
    # the top of the jambs. Overlap slightly: a hairline gap here shows sky.
    lin.location = (0, 0, H - 0.04)
    parts.append(lin)

    # Stepped crown over the lintel centre, matching the procedural silhouette.
    for w, h, z in ((3.0, 0.4, H + 0.86), (1.7, 0.38, H + 1.26)):
        c = polygonal_wall(f"{name}_crown{w}", w, h, TH * 0.92, rng,
                           joint=0.045, target=0.8)
        c.location = (0, 0, z)
        parts.append(c)
    return parts


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
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0006)
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
    print(f"KIT_OK {filename} faces={n} bytes={size}")
    return path


def build_all(outdir):
    os.makedirs(outdir, exist_ok=True)
    specs = []

    # --- the gateway the player runs through -------------------------------
    reset()
    parts = portada("portada", random.Random(SEED))
    specs.append(export(join_and_finalize(parts, "portada"), outdir, "portada.glb"))

    # --- wall runs, sized to tile along the 36 m chunk ---------------------
    for ln, tag in ((9.0, "9m"), (4.5, "4m5")):
        reset()
        w = polygonal_wall(f"wall_{tag}", ln, 2.4, 0.62,
                           random.Random(SEED + int(ln * 10)))
        specs.append(export(join_and_finalize([w], f"wall_{tag}"),
                            outdir, f"wall_{tag}.glb"))

    # --- a low terrace-style retaining course ------------------------------
    reset()
    w = polygonal_wall("wall_low_9m", 9.0, 1.15, 0.55,
                       random.Random(SEED + 77), target=0.72)
    specs.append(export(join_and_finalize([w], "wall_low_9m"),
                        outdir, "wall_low_9m.glb"))

    print("KIT_DONE", len(specs))


if __name__ == "__main__":
    argv = sys.argv
    outdir = argv[-1] if "--" in argv else "assets/kit"
    build_all(outdir)
