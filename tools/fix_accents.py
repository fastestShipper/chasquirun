# One-shot orthography pass over the user-facing Spanish strings.
#
# Every replacement is an exact literal and must match EXACTLY ONCE. A count of
# 0 means the source drifted and the fix silently did nothing; a count above 1
# means the key was ambiguous and we would be editing something unintended.
# Either way the script refuses to write, because a half-applied text pass is
# worse than none.

import io
import sys

FIXES = {
    'src/nemesis.js': [
        ('Me aburri. Sigue corriendo.', 'Me aburrí. Sigue corriendo.'),
        ('Yo se que es comida. Lo huelo.', 'Yo sé que es comida. Lo huelo.'),
        ('¡Casi! Se me escapo el almuerzo.', '¡Casi! Se me escapó el almuerzo.'),
        ('¡Ya! Ni sabia rico igual.', '¡Ya! Ni sabía rico igual.'),
        ('Killa te dejo sin piso.', 'Killa te dejó sin piso.'),
        ('Caiste al abismo.', 'Caíste al abismo.'),
        ('Killa te empujo al muro.', 'Killa te empujó al muro.'),
        ('Killa te barrio.', 'Killa te barrió.'),
        ('¡Mio!', '¡Mío!'),
    ],
    'src/main.js': [
        ('El pututu ha despertado. Invocalo con Shift.',
         'El pututu ha despertado. Invócalo con Shift.'),
        ('Toca el boton RAYO para invocar al sol',
         'Toca el botón RAYO para invocar al sol'),
        ('Lee el carril y deslizate a otro: fallara',
         'Lee el carril y deslízate a otro: fallará'),
        ('Lee el carril y cambiate a otro: fallara',
         'Lee el carril y cámbiate a otro: fallará'),
    ],
    'src/ui.js': [
        ('Ñan. Entregalo cueste lo que cueste.',
         'Ñan. Entrégalo cueste lo que cueste.'),
    ],
    'index.html': [
        ('Qhapaq Nan', 'Qhapaq Ñan'),
    ],
    'manifest.webmanifest': [
        ('Qhapaq Nan', 'Qhapaq Ñan'),
    ],
}


def main(root):
    problems = []
    staged = {}
    for rel, pairs in FIXES.items():
        path = f"{root}/{rel}"
        with io.open(path, encoding='utf-8') as f:
            text = f.read()
        for old, new in pairs:
            n = text.count(old)
            if n != 1:
                problems.append(f"{rel}: {n} matches for {old!r}")
                continue
            text = text.replace(old, new)
        staged[path] = text

    if problems:
        print("FIX_ABORT")
        for p in problems:
            print("  " + p)
        sys.exit(1)

    for path, text in staged.items():
        with io.open(path, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
        print(f"FIX_OK {path}")
    print("FIX_DONE")


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
