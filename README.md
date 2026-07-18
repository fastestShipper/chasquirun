# CHASQUI RUN

Un endless runner premium ambientado en el mundo incaico. Eres un chasqui, el
legendario mensajero del Inca, y corres por el Valle Sagrado, la Ciudadela, la
Puna y el Gran Puente colgante llevando tu qipi con el mensaje.

100% autocontenido: Three.js r170 vendorizado, texturas procedurales, música
andina sintetizada en tiempo real con WebAudio (quena, zampoña, charango,
bombo, chajchas), personajes y escenografía generados por código. Cero
dependencias externas en runtime, cero red.

## Jugar

Necesitas servirlo por HTTP (los módulos ES no cargan desde `file://`):

```bash
# opción 1
python -m http.server 5173
# opción 2
npx http-server -p 5173 -c-1 .
```

Abre http://localhost:5173

## Controles

- Flechas o WASD: moverte de carril, saltar, deslizarte
- Espacio: saltar
- Esc o P: pausa
- Móvil: desliza (izquierda/derecha/arriba/abajo), toca para saltar

## Elementos del mundo

- Soles de oro: monedas
- Chakana sagrada: 25 soles
- Inti (sol dorado): escudo que absorbe un golpe
- Wayra (viento celeste): ráfaga de velocidad, invulnerable y soles x2
- Quri (imán violeta): atrae los soles cercanos

## Estructura

```
index.html          shell + import map
lib/                three.js r170 + addons de postprocesado (vendorizados)
css/style.css       interfaz
src/
  main.js           bootstrap + máquina de estados + loop
  config.js         constantes y paleta
  materials.js      fábrica de texturas procedurales + curvatura del mundo
  track.js          chunks por bioma, obstáculos, monedas
  player.js         física del corredor y colisiones
  character.js      el chasqui (modelo + animación procedural)
  animals.js        llamas, alpacas, cóndores
  scenery.js        andenes, portadas, torreones, puente q'eswachaka
  sky.js            cielo, sol, nevados, nubes, cóndores lejanos
  water.js          ríos y lagunas (shader propio)
  particles.js      polvo, chispas, nieve, neblina, brasas
  audio/            motor WebAudio: música andina + SFX + ambiencias
  ui.js             pantallas y HUD
```
