# Verify the gateway's lane clearance directly from the exported GLB.
#
# The gateway is the one kit piece the player runs THROUGH, so its opening is
# gameplay, not decoration. Lanes sit at x = -2.2, 0, +2.2 (src/config.js) and
# src/scenery.js documents the contract: clear for x in [-3.4, 3.4] below
# y 3.2. A jamb that creeps inside that box makes an outer lane impassable.
#
# This measures the ACTUAL exported mesh after the same height normalisation
# src/assets.js applies (kit_portada is registered with height 5.4), so it
# catches an authoring mistake that eyeballing a render cannot.
#
#   blender -b --factory-startup -noaudio -P tools/kit_clearance.py -- <glb>

import bpy
import sys

REQUIRED_HALF = 3.4    # opening must be clear to +-3.4 ...
REQUIRED_UP_TO = 3.2   # ... at every height below this
TARGET_HEIGHT = 5.4    # what src/assets.js normalises kit_portada to


def main(glb):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not objs:
        print("CLEAR_FAIL no mesh")
        return

    # The glTF importer converts Y-up back to Blender's native Z-up, so the
    # game's HEIGHT axis is Blender z here, not y. Getting this wrong measures
    # the wall's thickness and reports nonsense, so map it explicitly.
    vs = []
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            vs.append((w.x, w.z, w.y))   # (game_x, game_height, _)

    ymin = min(v[1] for v in vs)
    ymax = max(v[1] for v in vs)
    k = TARGET_HEIGHT / max(ymax - ymin, 1e-6)
    print(f"CLEAR_INFO natural_height={ymax - ymin:.3f} scale={k:.4f}")

    # Walk up the opening and find the innermost geometry on each side.
    worst = 1e9
    worst_y = None
    y = 0.05
    while y <= REQUIRED_UP_TO + 1e-9:
        band = [v for v in vs if abs((v[1] - ymin) * k - y) < 0.09]
        left = [v[0] * k for v in band if v[0] < 0]
        right = [v[0] * k for v in band if v[0] > 0]
        li = max(left) if left else -1e9    # innermost left face
        ri = min(right) if right else 1e9   # innermost right face
        half = min(-li, ri)
        if half < worst:
            worst, worst_y = half, y
        status = "ok" if half >= REQUIRED_HALF else "BLOCKED"
        print(f"CLEAR_ROW y={y:.2f} half={half:.3f} {status}")
        y += 0.1

    if worst >= REQUIRED_HALF:
        print(f"CLEAR_PASS min_half={worst:.3f} at y={worst_y:.2f} "
              f"(need {REQUIRED_HALF}) margin={worst - REQUIRED_HALF:.3f}")
    else:
        print(f"CLEAR_FAIL min_half={worst:.3f} at y={worst_y:.2f} "
              f"(need {REQUIRED_HALF})")


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--") + 1:][0])
