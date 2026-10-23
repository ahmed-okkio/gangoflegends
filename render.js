// Three.js view of a match. Knows nothing about physics: it draws whatever snapshots it's given.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAPS } from './maps.js';
import { CHAMPS, TEAM_COLORS, FFA_COLORS } from './champs.js';
import { PARTS, ORDER, ANCHOR, HAND, CHEST, HEAD, ARM, FORE, LEG, HIPS, HIP_HEIGHT, qmul, qinv, qrot } from './beast.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { beastAsset, xhr } from './stages.js';
import { playEvents } from './sfx.js';

// Champion props, remade Gang Beasts style in Blender (tools/model_props.py -> assets/props/). Each is modelled in its
// part's frame, so it parents with no offset. [prop, part, tag]
const PROPS = {
  blitz: [['core', CHEST], ['gauntletL', FORE, 'fist'], ['gauntletR', FORE + 1, 'fist']],
  hec: [['blade', HEAD], ['tail', HIPS], ['hoofHand', FORE], ['hoofHand', FORE + 1], ['hoofFoot', LEG], ['hoofFoot', LEG + 1]],
  vi: [['hair', HEAD], ['gauntletL', FORE, 'fist'], ['gauntletR', FORE + 1, 'fist']],
  sett: [['jacket', CHEST], ['fist', FORE, 'fist'], ['fist', FORE + 1, 'fist']],
  ali: [['horns', HEAD], ['cuff', FORE], ['cuff', FORE + 1]],
  thresh: [['crown', HEAD], ['pauldrons', CHEST], ['lantern', FORE]],
  singed: [['tank', CHEST], ['goggles', HEAD]],
  lee: [['blindfold', HEAD], ['wrap', FORE], ['wrap', FORE + 1]],
};
const PROP_FILE = { blitz: 'blitzcrank', hec: 'hecarim', vi: 'vi', sett: 'sett', ali: 'alistar', thresh: 'thresh', singed: 'singed', lee: 'leesin' };
const propScenes = {}; // 'blitz/core' -> parsed glTF scene
export async function loadProps() {
  if (Object.keys(propScenes).length) return;
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(PROPS).flatMap(([champ, list]) => list.map(async ([name]) => {
    try {
      const buf = await xhr(`./assets/props/${PROP_FILE[champ]}_${name}.glb`, 'arraybuffer');
      propScenes[`${champ}/${name}`] = (await loader.parseAsync(buf, '')).scene;
    } catch (e) { console.warn('prop', champ, name, e); }
  })));
}

const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });
const glow = (color, k = 2.2) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: k, roughness: 0.3 });
// Gang Beasts' fire pit glow: the pit's mouth glows hot orange (bright enough to bloom) right up to the rim
// (their shader fades it by the pit's depth behind it; distance from the rim stands in). The pit's side faces stay clear.
function pitGlow(lo, hi) {
  return new THREE.ShaderMaterial({
    uniforms: { lo: { value: lo }, hi: { value: hi } },
    vertexShader: 'varying vec3 vP; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `uniform vec2 lo, hi; varying vec3 vP;
      void main() { vec2 e = min(vP.xz - lo, hi - vP.xz); float d = min(e.x, e.y);
        gl_FragColor = vec4(10.0, 2.6, 0.0, smoothstep(0.0, 0.08, d)); }`, // _EmissionColor (30, 10, 0) scaled: three.js bloom spreads further than URP's
    transparent: true, depthWrite: false,
  });
}
// Gang Beasts gummy: soft clearcoat sheen over a matte body
const gummy = (color, extra = {}) => new THREE.MeshPhysicalMaterial({
  color, roughness: 0.55, clearcoat: 0.8, clearcoatRoughness: 0.3, sheen: 0.6, sheenRoughness: 0.5,
  sheenColor: new THREE.Color(color).lerp(new THREE.Color('#fff'), 0.5), ...extra,
});
const mesh = (geo, mat, x = 0, y = 0, z = 0, shadow = true) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow; m.receiveShadow = shadow;
  return m;
};
const rand = (a, b) => a + Math.random() * (b - a);

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
// speckled noise over a base colour: concrete, worn paint
const noiseTex = (base, spread, n = 4000) => canvasTex(256, 256, (x, w, h) => {
  x.fillStyle = base; x.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = Math.random() * spread * 2 - spread;
    x.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    x.fillRect(Math.random() * w, Math.random() * h, rand(1, 3), rand(1, 3));
  }
});
const diamondTex = () => canvasTex(128, 128, (x, w, h) => {
  x.fillStyle = '#8f939c'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    x.save(); x.translate(i * 32 + (j % 2) * 16 + 8, j * 32 + 16); x.rotate((j % 2 ? 1 : -1) * 0.8);
    x.fillStyle = '#b5b9c2'; x.fillRect(-9, -2.5, 18, 5);
    x.fillStyle = '#6b6f78'; x.fillRect(-9, 2, 18, 1.5);
    x.restore();
  }
});
const hazardTex = () => canvasTex(128, 32, (x, w, h) => {
  x.fillStyle = '#f2c230'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#1c1c1c';
  for (let i = -2; i < 6; i++) { x.beginPath(); x.moveTo(i * 32, h); x.lineTo(i * 32 + 16, h); x.lineTo(i * 32 + 32, 0); x.lineTo(i * 32 + 16, 0); x.fill(); }
});
const softDot = canvasTex(64, 64, (x) => {
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
}, false);

export const playerColor = (setup, slot) => {
  const p = setup.players[slot];
  return setup.teams ? TEAM_COLORS[p.team] : FFA_COLORS[slot % FFA_COLORS.length];
};

const VignetteShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.35 }, contrast: { value: 1 }, saturation: { value: 1 }, shadows: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  // plus a light colour grade (Gang Beasts' URP profile: contrast, saturation, darker shadows), in display space
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength, contrast, saturation, shadows; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, saturation); c.rgb = (c.rgb - 0.5) * contrast + 0.5;
      c.rgb *= 1.0 - shadows * (1.0 - smoothstep(0.0, 0.35, l));
      float d = distance(vUv, vec2(0.5)); c.rgb *= 1.0 - strength * smoothstep(0.35, 0.85, d); gl_FragColor = c; }`,
};

// one submesh ([first index, count]) of an imported mesh as its own compact geometry, in world space (M), with the
// renderer's lightmap scale/offset (lm) baked into uv1
function submesh(src, [start, count], M, lm) {
  const idx = src.index.array, remap = new Map(), out = new Uint32Array(count);
  for (let i = 0; i < count; i++) { const v = idx[start + i]; out[i] = remap.get(v) ?? remap.set(v, remap.size).get(v); }
  if (M && M.determinant() < 0) for (let i = 0; i < count; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]]; // mirrored: keep the winding
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    const n = a.itemSize, arr = new Float32Array(remap.size * n);
    for (const [o, j] of remap) for (let c = 0; c < n; c++) arr[j * n + c] = a.array[o * n + c];
    g.setAttribute(k, new THREE.BufferAttribute(arr, n));
  }
  g.setIndex(new THREE.BufferAttribute(out, 1));
  if (M) g.applyMatrix4(M);
  if (lm) { const u = g.attributes.uv1; for (let i = 0; i < u.count; i++) u.setXY(i, u.getX(i) * lm[0] + lm[2], u.getY(i) * lm[1] + lm[3]); }
  return g;
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnv;
  let skyEnv = null; // an imported stage's own sky, prefiltered (buildImported)
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
  camera.layers.enable(1); // layer 1: the imported far-off city

  // HDR render target with MSAA, AO, bloom on the bright bits, then tone map + vignette
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  // ambient occlusion: contact shading in corners, under props and between the beasts' limbs
  // it sees through its own camera (synced in render()) without layer 1: the far-off city, ~300 draw calls of no use to it
  const aoCam = new THREE.PerspectiveCamera();
  const ao = new GTAOPass(scene, aoCam, 1, 1, undefined, { radius: 0.6, distanceExponent: 1.5, thickness: 2, scale: 1.2, samples: 6 }, { samples: 6, rings: 2, radius: 6 });
  ao.blendIntensity = 0.85;
  const aoSize = ao.setSize.bind(ao); ao.setSize = (w, h) => aoSize(w / 2, h / 2); // half res: soft anyway, a quarter of the cost
  composer.addPass(ao);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(VignetteShader);
  composer.addPass(grade);
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize); resize();

  const hemi = new THREE.HemisphereLight('#fff4e0', '#4a4060', 1.1);
  const sun = new THREE.DirectionalLight('#fff1d6', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 80 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02;
  const rim = new THREE.DirectionalLight('#9ad8ff', 0.9); // cool back light so silhouettes pop
  scene.add(hemi, sun, sun.target, rim);

  let world = null, avatars = [], rollers = [], hookPool = [], gluePool = [], setup = null, animated = [];
  const camAt = new THREE.Vector3(0, 0, 0);
  let camDist = 14, shake = 0, time = 0;
  const sunOffset = new THREE.Vector3(8, 20, 6);
  let cam = { side: 1, pitch: 0.63, min: 10, max: 24 }; // side -1 = camera on the -z side, looking +z
  // calibration knobs for imported Unity lighting (URP intensities don't map 1:1 onto three.js)
  // Unity lights and lightmaps multiply albedo straight; three.js divides diffuse by PI. Lightmaps are RGBM: x 5^2.2 (tools/import_gb.py).
  const LIGHTMAP_GAIN = Math.PI * 34.49, LIGHT_GAIN = Math.PI;

  // ---------- particles ----------
  const particles = [];
  const pGroup = new THREE.Group();
  scene.add(pGroup);
  // dir: a heading the burst leans along (the random spread is added to it); grow: puffs that swell as they fade (smoke)
  function emit(pos, { color = '#fff', n = 8, speed = 4, size = 0.25, life = 0.5, grav = -6, spread = 1, up = 0, additive = true, opacity = 1, dir = null, grow = false }) {
    for (let i = 0; i < n; i++) {
      let p = particles.find(q => q.life <= 0);
      if (!p) {
        if (particles.length > 400) return;
        p = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, depthWrite: false })) };
        pGroup.add(p.sprite);
        particles.push(p);
      }
      const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1) * spread + up, rand(-1, 1));
      if (dir) d.multiplyScalar(0.45).add(dir);
      d.normalize().multiplyScalar(speed * rand(0.4, 1));
      Object.assign(p, { vel: d, life: life * rand(0.7, 1.2), max: life, size: size * rand(0.7, 1.3), grav, opacity, grow });
      p.max = p.life;
      p.sprite.material.color.set(color);
      p.sprite.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.sprite.position.copy(pos);
      p.sprite.visible = true;
    }
  }
  function stepParticles(dt) {
    for (const p of particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      p.vel.y += p.grav * dt;
      p.vel.multiplyScalar(1 - 2 * dt);
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = p.life / p.max;
      p.sprite.material.opacity = k * p.opacity;
      p.sprite.scale.setScalar(p.size * (p.grow ? 2 - k * 1.4 : 0.5 + k * 0.7));
    }
  }
  const rings = [];
  // a ring that bursts outward facing the camera, or (inward) lies on the floor and closes in on its centre; flat: on the floor either way
  function ring(pos, color, size, inward = false, max = 0.3, flat = inward) {
    let r = rings.find(q => q.life <= 0);
    if (!r) {
      r = { m: new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 48), new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })) };
      scene.add(r.m); rings.push(r);
    }
    r.m.position.copy(pos);
    if (flat) r.m.rotation.set(-Math.PI / 2, 0, 0); else r.m.quaternion.copy(camera.quaternion);
    r.m.material.color.set(color);
    Object.assign(r, { life: max, max, size, inward });
    r.m.visible = true;
  }
  function stepRings(dt) {
    for (const r of rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      r.m.visible = r.life > 0;
      const k = 1 - r.life / r.max;
      r.m.scale.setScalar(r.size * (r.inward ? 1 - 0.85 * k * k : 0.2 + k));
      r.m.material.opacity = r.inward ? 1 - k * 0.6 : 1 - k;
    }
  }

  function fx(events) {
    playEvents(events);
    const v = new THREE.Vector3();
    for (const [kind, x, y, z, big] of events) {
      v.set(x, y, z);
      if (kind === 'hit') {
        emit(v, { color: big ? '#ffb347' : '#fff3b0', n: big ? 18 : 9, speed: big ? 7 : 4.5, size: big ? 0.35 : 0.22, life: 0.35, grav: 0 });
        ring(v, big ? '#ffb347' : '#ffffff', big ? 1.4 : 0.8);
        shake = Math.max(shake, big ? 0.25 : 0.08);
      } else if (kind === 'ko') {
        emit(v, { color: '#ffd84a', n: 14, speed: 3, size: 0.25, life: 0.8, grav: -2, up: 1 });
        ring(v, '#ffd84a', 1.2);
      } else if (kind === 'fb') { // Sett's Facebreaker: its reach, snapping shut
        v.y -= 0.6;
        ring(v, '#ffb000', 2.4, true, 0.35);
        ring(v, '#ffffff', 2.4, true, 0.2);
        shake = Math.max(shake, 0.12);
      } else if (kind === 'vi') { // Relentless Force: a blast of smoke shoved out through the cone behind the target (sim.js relentless)
        const dir = tmp2.set(Math.sin(big), 0, Math.cos(big));
        emit(v, { color: '#c9a3b6', n: 22, speed: 6, size: 1.1, life: 0.9, grav: 0.6, dir, grow: true, additive: false, opacity: 0.7 });
        emit(v, { color: '#ff5fae', n: 10, speed: 8, size: 0.18, life: 0.4, grav: 0, dir });
        shake = Math.max(shake, 0.15);
      } else if (kind === 'flay') { // Thresh's Flay: a green arc of chain swept through the line
        const dir = tmp2.set(Math.sin(big), 0, Math.cos(big));
        emit(v, { color: '#7dff9a', n: 18, speed: 7, size: 0.22, life: 0.35, grav: 0, dir: dir.negate() });
        ring(v, '#7dff9a', 1.6);
        shake = Math.max(shake, 0.1);
      } else if (kind === 'wave') { // Sonic Wave leaving Lee's palm
        emit(v, { color: '#4fe3ff', n: 10, speed: 3, size: 0.22, life: 0.3, grav: 0 });
        ring(v, '#4fe3ff', 0.7);
      } else if (kind === 'sonic') { // Lee Sin's Sonic Wave marking whoever it hit
        emit(v, { color: '#5fb8ff', n: 14, speed: 4, size: 0.25, life: 0.4, grav: 0 });
        ring(v, '#5fb8ff', 1.2);
      } else if (kind === 'rage') { // Dragon's Rage: a burst of golden fire out along the kick
        const dir = tmp2.set(Math.sin(big), 0, Math.cos(big));
        emit(v, { color: '#ffb000', n: 20, speed: 7, size: 0.3, life: 0.45, grav: 0, dir });
        ring(v, '#ffd27a', 1.6);
        shake = Math.max(shake, 0.2);
      } else if (kind === 'glue') { // Singed's Mega Adhesive splatting down
        emit(v, { color: '#a6ff00', n: 20, speed: 4, size: 0.3, life: 0.6, grav: 8, up: 3, additive: false, opacity: 0.9 });
      } else if (kind === 'fling') {
        emit(v, { color: '#d4ff3d', n: 12, speed: 4, size: 0.3, life: 0.5, grav: -2, up: 2 });
        shake = Math.max(shake, 0.15);
      } else if (kind === 'pulv') { // Alistar's Pulverize: a shockwave across the floor and rubble thrown up
        v.y -= 0.6;
        ring(v, '#ffb347', 2.8, false, 0.4, true);
        ring(v, '#ffffff', 2.2, false, 0.25, true);
        emit(v, { color: '#8a7a66', n: 24, speed: 5, size: 0.4, life: 0.7, grav: 8, up: 4, additive: false, opacity: 0.9 });
        shake = Math.max(shake, 0.3);
      } else if (kind === 'out') {
        emit(v, { color: '#ffffff', n: 30, speed: 6, size: 0.5, life: 0.9, grav: 2, additive: false, opacity: 0.8 });
        emit(v, { color: '#ff7a3d', n: 16, speed: 8, size: 0.35, life: 0.5, grav: 0 });
        shake = Math.max(shake, 0.35);
      }
    }
  }

  function setMatch(s) {
    setup = s;
    if (world) scene.remove(world);
    world = new THREE.Group();
    scene.add(world);
    animated = [];
    rollers = buildMap(world, MAPS[s.map], s.map);
    for (const l of [hemi, sun, rim]) l.visible = l.intensity > 0; // an unlit light still costs every shader, and the sun a 4096² shadow pass
    avatars = s.players.map((p, slot) => { const a = makeAvatar(p.champ, playerColor(s, slot), p.name, !!s.teams); world.add(a.group); return a; });
    hookPool = []; gluePool = [];
    camAt.set(0, 0, 0); camDist = 14;
  }

  function sky(top, horizon, bottom) {
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(top) }, horizon: { value: new THREE.Color(horizon) }, bottom: { value: new THREE.Color(bottom) } },
      vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top, horizon, bottom; varying vec3 vP;
        void main() { float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.6)) : mix(horizon, bottom, pow(-h, 0.5)); gl_FragColor = vec4(c, 1.0); }`,
    });
    const s = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), m);
    s.name = 'sky';
    return s;
  }

  // collider box drawn as an I-beam with rivets (the collider stays a plain box)
  function iBeam(g, b, mat, rivet) {
    const [hx, hy, hz] = b.s, along = hx >= hz ? 'x' : 'z', y0 = b.p[1];
    const flange = 0.07, web = Math.min(hx, hz) * 0.25;
    const beam = new THREE.Group();
    beam.position.set(b.p[0], 0, b.p[2]);
    beam.add(mesh(new THREE.BoxGeometry(hx * 2, flange * 2, hz * 2), mat, 0, y0 + hy - flange, 0));
    beam.add(mesh(new THREE.BoxGeometry(hx * 2 * 0.98, flange * 2, hz * 2 * 0.98), mat, 0, y0 - hy + flange, 0));
    beam.add(mesh(along === 'x' ? new THREE.BoxGeometry(hx * 2, hy * 2, web * 2) : new THREE.BoxGeometry(web * 2, hy * 2, hz * 2), mat, 0, y0, 0));
    const n = Math.floor((along === 'x' ? hx : hz) * 2 / 0.7);
    const geo = new THREE.SphereGeometry(0.035, 6, 4);
    const studs = new THREE.InstancedMesh(geo, rivet, n * 2);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) for (const s of [-1, 1]) {
      const t = -1 + (i + 0.5) / n * 2, edge = (along === 'x' ? hz : hx) - 0.1;
      m4.makeTranslation(along === 'x' ? t * hx : s * edge, y0 + hy + 0.005, along === 'x' ? s * edge : t * hz);
      studs.setMatrixAt(i * 2 + (s > 0 ? 1 : 0), m4);
    }
    beam.add(studs);
    g.add(beam);
  }

  // a stage imported from Gang Beasts: original meshes, textures and baked bounce light
  // the incinerator's pit: a glowing surface that blooms, a steady warm light over it (Gang Beasts' flames suggest one),
  // embers drifting up and now and then a splash of lava blobs arcing up out of it
  function pitFire(g, geo) {
    geo.computeBoundingBox();
    const { min, max } = geo.boundingBox;
    g.add(new THREE.Mesh(geo, pitGlow(new THREE.Vector2(min.x, min.z), new THREE.Vector2(max.x, max.z))));
    const lava = new THREE.Color(8, 2.2, 0.3), ember = lava; // past the bloom's soft knee
    // gentle 1/d falloff, high up: beasts beside the pit get about sun-level light, so their gloss doesn't blow out and bloom
    const heat = new THREE.PointLight(new THREE.Color(1, 0.4, 0.05), 14, 24, 1); // intensity by eye
    heat.position.set((min.x + max.x) / 2, max.y + 3, (min.z + max.z) / 2);
    g.add(heat);
    let next = 0, nextEmber = 0;
    animated.push(o => {
      if (o.time >= nextEmber) {
        nextEmber = o.time + 0.08;
        emit(new THREE.Vector3(rand(min.x, max.x), max.y, rand(min.z, max.z)), { color: ember, n: 1, speed: 2.5, size: 0.07, life: 2.2, grav: 3, spread: 0.2, up: 6 });
      }
      if (o.time < next) return;
      next = o.time + rand(0.3, 1.2);
      emit(new THREE.Vector3(rand(min.x + 0.5, max.x - 0.5), max.y, rand(min.z + 0.5, max.z - 0.5)), { color: lava, n: 3 + Math.floor(rand(0, 4)), speed: 7, size: 0.22, life: 1.4, grav: -14, spread: 0.25, up: 4 });
    });
  }

  function buildImported(g, { scene: sc, bins, base }, view = {}) {
    const loader = new THREE.TextureLoader(), texCache = {};
    const lightmapTex = sc.lightmaps.map(name => Object.assign(loader.load(base + name), { colorSpace: THREE.SRGBColorSpace, channel: 1 }));
    const tex = (name, srgb = true) => texCache[name] ??= Object.assign(loader.load(base + name), {
      colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: 8,
    });
    const geos = {};
    for (const [key, m] of Object.entries(sc.meshes)) {
      const buf = bins[key]; let o = 0;
      const take = (n, Arr = Float32Array) => { const a = new Arr(buf, o, n); o += n * 4; return a; };
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(take(m.verts * 3), 3));
      if (m.normals) geo.setAttribute('normal', new THREE.BufferAttribute(take(m.verts * 3), 3));
      if (m.uv0) geo.setAttribute('uv', new THREE.BufferAttribute(take(m.verts * 2), 2));
      if (m.uv1) geo.setAttribute('uv1', new THREE.BufferAttribute(take(m.verts * 2), 2));
      geo.setIndex(new THREE.BufferAttribute(take(m.indices, Uint32Array), 1));
      if (!m.normals) geo.computeVertexNormals();
      geos[key] = geo;
    }
    const mats = {};
    const material = (key, li) => {
      const id = key + '|' + li;
      if (mats[id]) return mats[id];
      const d = sc.materials[key];
      const m = new THREE.MeshStandardMaterial({
        // water uses Gang Beasts' own shader; a plain sea blue stands in
        color: /^Water/.test(d.name) ? new THREE.Color('#2f7fb5') : new THREE.Color().setRGB(d.color[0], d.color[1], d.color[2], THREE.SRGBColorSpace),
        map: d.map ? tex(d.map) : null, roughness: 1 - d.smoothness * 0.8, metalness: d.metallic,
      });
      if (d.emission && Math.max(...d.emission) > 0) m.emissive.setRGB(...d.emission.map(v => Math.min(v, 1)));
      // lightmapped surfaces get their ambient from the lightmap alone, like in Unity
      if (li >= 0) { m.lightMap = lightmapTex[li]; m.lightMapIntensity = LIGHTMAP_GAIN * (view.dim ?? 1); m.envMapIntensity = 0; }
      return (mats[id] = m);
    };
    // static batching: every submesh is baked into world space (lightmap tiling into its uv1) and merged with the
    // others sharing its material, so the stage is a few dozen draw calls instead of ~1500
    const batches = {};
    // a Unity light's culling mask also picks what casts its shadows (Incinerator's fire light shines in through walls
    // left out of it). three.js shadows can't differ per light, so a layer any shadowed light leaves out casts none.
    const shadowLayers = (sc.lights ?? []).filter(l => l.shadows).reduce((m, l) => m & (l.mask >>> 0), 0xffffffff) >>> 0;
    for (const r of sc.renderers) {
      const src = geos[r.mesh], meta = sc.meshes[r.mesh], li = r.lightmap >= 0 && meta.uv1 ? r.lightmap : -1;
      const M = r.matrix && new THREE.Matrix4().set(...r.matrix.flat()), city = r.path.includes('/City');
      r.subs.forEach((s, i) => {
        if (!meta.subs[s] || !r.mats.length) return;
        const geo = submesh(src, meta.subs[s], M, li >= 0 && r.lmso), key = r.mats[Math.min(i, r.mats.length - 1)];
        const cast = r.layer != null && !(shadowLayers >>> r.layer & 1) ? 0 : r.cast ?? 1, recv = r.recv ?? true;
        (batches[[key, li, city, cast, recv, Object.keys(geo.attributes)].join('|')] ??= { key, li, city, cast, recv, geos: [] }).geos.push(geo);
      });
    }
    for (const { key, li, city, cast, recv, geos } of Object.values(batches)) {
      if (/^Firepit Glow/.test(sc.materials[key].name)) { pitFire(g, mergeGeometries(geos)); continue; }
      // Unity's per-renderer shadow settings: "shadows only" draws nothing but still casts
      // Unity draws "on" casters' shadows with their faces toward the light (back faces culled) and "two sided" with
      // both; three.js defaults to the faces away from the light, which would let a room's walls shade light from outside
      let mat = cast === 3 ? new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }) : material(key, li);
      if (cast > 0) { mat = mat.clone(); mat.shadowSide = cast === 2 ? THREE.DoubleSide : THREE.FrontSide; }
      const m = new THREE.Mesh(mergeGeometries(geos), mat);
      m.castShadow = !city && cast > 0; m.receiveShadow = !city && recv;
      if (city) m.layers.set(1);
      g.add(m);
    }
    // the stage's runtime lights. The strongest directional one is the shadow-casting sun; a few spots cast shadows too
    hemi.intensity = 0; rim.intensity = 0; sun.intensity = 0; // ambient: the environment map (beasts) and lightmaps (stage)
    const col = l => new THREE.Color().setRGB(...l.color, THREE.SRGBColorSpace);
    let spotShadows = 0;
    for (const l0 of [...sc.lights ?? []].sort((a, b) => b.intensity - a.intensity)) {
      const l = { ...l0, ...view.lights?.[l0.name] }; // maps.js can retune a light
      const I = l.intensity * LIGHT_GAIN;
      if (l.type === 'sun' && !sun.intensity) { sun.color.copy(col(l)); sun.intensity = I; sunOffset.set(...l.dir).normalize().multiplyScalar(-30); continue; }
      const L = l.type === 'sun' ? new THREE.DirectionalLight(col(l), I)
        : l.type === 'point' ? new THREE.PointLight(col(l), I, l.range, 2)
        : new THREE.SpotLight(col(l), I, l.range, l.angle / 2 * Math.PI / 180, 1 - l.inner / l.angle, 2);
      L.position.set(...l.p);
      if (L.target) { L.target.position.set(l.p[0] + l.dir[0], l.p[1] + l.dir[1], l.p[2] + l.dir[2]); g.add(L.target); }
      if (l.type === 'spot' && l.shadows && spotShadows < 4) { spotShadows++; L.castShadow = true; L.shadow.mapSize.set(1024, 1024); L.shadow.bias = -0.0005; }
      g.add(L);
    }
    // Gang Beasts' post profile (every stage's Volume): ACES, +1.4 EV, bloom intensity 1 over 2 (scatter 0.8), contrast +6, saturation +4, darker shadows, vignette 0.2
    // fine mips only: the glow hugs what blooms instead of washing the screen. Soft knee: things just over the threshold
    // (eyes, champion glows, glossy highlights) bloom faintly, the pit and lava fully
    bloom.highPassUniforms.smoothWidth.value = 2.5;
    bloom.strength = 0.4; bloom.threshold = 2; bloom.radius = 0; bloom.compositeMaterial.uniforms.bloomFactors.value = [1, 0.75, 0.35, 0.1, 0]; renderer.toneMappingExposure = 0.8; scene.environmentIntensity = 0.5 * (view.dim ?? 1); // exposure: by eye (three's ACES curve isn't URP's)
    Object.assign(grade.uniforms, { strength: { value: 0.2 }, contrast: { value: 1.06 }, saturation: { value: 1.04 }, shadows: { value: 0.3 } });
    scene.fog = null;
    // the stage's own sky, as Unity bakes it (import_gb.py): the backdrop, and the light on everything without a lightmap,
    // beasts included. Its mean is the stage's ambient probe, so it goes in at full strength. Unity's cube faces are in
    // its left-handed frame: a half turn about y lines them up with ours (z flipped)
    if (sc.env?.sky) {
      const cube = new THREE.CubeTextureLoader().setPath(base).load(sc.env.sky, t => {
        if (scene.background !== t) return; // left the map meanwhile
        skyEnv?.dispose(); skyEnv = pmrem.fromCubemap(t); scene.environment = skyEnv.texture;
      });
      cube.colorSpace = THREE.SRGBColorSpace;
      scene.background = cube; scene.backgroundRotation.set(0, Math.PI, 0); scene.environmentRotation.set(0, Math.PI, 0);
      scene.environmentIntensity = view.dim ?? 1;
      if (sc.env.fog) scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(...sc.env.fogColor, THREE.SRGBColorSpace), sc.env.fogDensity); // Unity's exponential squared
    } else g.add(sky(...view.sky ?? ['#6fb2ee', '#d8ecfa', '#b9c9d6']));
    // Trawler's sea is built at runtime by Gang Beasts' water script (nothing to import): a plain sea at its height, in
    // its material's horizon colour and opacity ("Water - Trawler"), glossy so it mirrors the sky like theirs
    if (view.sea != null) {
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#0e3e48', roughness: 0.15, transparent: true, opacity: 0.94 }));
      sea.position.y = view.sea; sea.receiveShadow = true; g.add(sea);
    }
    // like the stage's own camera: Girders' looks from -z at 27 degrees
    const c = { side: -1, pitch: 27, min: 17, max: 28, ...view.cam };
    cam = { ...c, pitch: c.pitch * Math.PI / 180 };
    if (view.poro) g.add(poro(...view.poro)); // easter egg
  }

  function buildMap(g, map, id) {
    sunOffset.set(8, 20, 6);
    scene.environment = roomEnv; scene.background = null; scene.environmentRotation.set(0, 0, 0);
    Object.assign(grade.uniforms, { strength: { value: 0.35 }, contrast: { value: 1 }, saturation: { value: 1 }, shadows: { value: 0 } });
    bloom.radius = 0.55; bloom.highPassUniforms.smoothWidth.value = 0.01; bloom.compositeMaterial.uniforms.bloomFactors.value = [1, 0.8, 0.6, 0.4, 0.2]; rim.intensity = 0.9;
    cam = { side: 1, pitch: 0.63, min: 10, max: 24 };
    // Gang Beasts' stages have their occlusion baked into the lightmaps; AO on top cost about half the frame (Incinerator)
    ao.enabled = !map.imported;
    if (map.imported) { buildImported(g, map.imported, map.view); return []; }
    const paint = noiseTex('#d4502f', 0.12);
    const girder = std('#ffffff', { map: paint, roughness: 0.55, metalness: 0.35 });
    const rivet = std('#a23a22', { metalness: 0.5, roughness: 0.4 });
    const plateTex = id === 'grind' ? noiseTex('#5f675e', 0.1, 9000) : diamondTex();
    const dark = std('#3b3f4a', { roughness: 0.6, metalness: 0.5 });
    map.boxes.forEach((b, i) => {
      if (b.m === 'girder') return iBeam(g, b, girder, rivet);
      const [hx, hy, hz] = b.s;
      let mat = dark;
      if (b.m === 'plate') {
        const t = plateTex.clone(); t.needsUpdate = true;
        t.repeat.set(hx * (id === 'grind' ? 0.5 : 1.2), hz * (id === 'grind' ? 0.5 : 1.2));
        mat = std('#ffffff', { map: t, roughness: id === 'grind' ? 0.9 : 0.4, metalness: id === 'grind' ? 0 : 0.6 });
      }
      // overlapping floor pieces share a top face; a hair of lift per box stops them z-fighting
      g.add(mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat, b.p[0], b.p[1] + i * 0.004, b.p[2]));
    });
    const rs = map.rollers.map(r => {
      const roller = new THREE.Group();
      roller.position.set(...r.p);
      const drum = mesh(new THREE.CylinderGeometry(r.r, r.r, r.hx * 2, 32), std('#5d636e', { metalness: 0.85, roughness: 0.3 }));
      drum.rotation.z = Math.PI / 2;
      roller.add(drum);
      const toothMat = std('#c7ccd4', { metalness: 0.9, roughness: 0.25 });
      for (let i = 0; i < 12; i++) for (let j = 0; j < 5; j++) {
        const a = i / 12 * Math.PI * 2 + j * 0.5, tooth = mesh(new THREE.ConeGeometry(0.08, 0.22, 4), toothMat);
        tooth.position.set(-r.hx + (j + 0.5) * r.hx * 2 / 5, Math.cos(a) * (r.r + 0.08), Math.sin(a) * (r.r + 0.08));
        tooth.rotation.x = a;
        roller.add(tooth);
      }
      g.add(roller);
      return { r, roller };
    });
    (id === 'grind' ? decorGrind : decorGirders)(g, map);
    return rs;
  }

  function cloud(x, y, z, s, mat) {
    const c = new THREE.Group();
    c.position.set(x, y, z);
    for (let i = 0; i < 6; i++) c.add(mesh(new THREE.SphereGeometry(rand(0.6, 1.1) * s, 12, 8), mat, rand(-1.4, 1.4) * s, rand(-0.2, 0.4) * s, rand(-0.6, 0.6) * s, false));
    return c;
  }

  function decorGirders(g) {
    hemi.color.set('#fff1dc'); hemi.groundColor.set('#7a5a6a'); hemi.intensity = 1.1;
    sun.color.set('#ffe2b8'); sun.intensity = 2.8; rim.color.set('#9ad8ff');
    bloom.strength = 0.35; bloom.threshold = 1.6; renderer.toneMappingExposure = 0.95; scene.environmentIntensity = 0.45;
    g.add(sky('#5aa4ff', '#ffd7ae', '#f3b98d'));
    scene.fog = new THREE.Fog('#f3c9a0', 45, 170);
    // drifting clouds below and around the beams
    const puff = std('#ffffff', { roughness: 1 });
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2), d = rand(16, 70);
      const c = cloud(Math.cos(a) * d, rand(-34, -16), Math.sin(a) * d, rand(2, 4), puff);
      c.userData.drift = rand(0.2, 0.6);
      animated.push(o => { c.position.x += c.userData.drift * o.dt; if (c.position.x > 60) c.position.x = -60; });
      g.add(c);
    }
    // Piltover far below: towers with glowing hextech roofs
    const towerTex = canvasTex(64, 128, (x, w, h) => {
      x.fillStyle = '#d8c39a'; x.fillRect(0, 0, w, h);
      for (let i = 4; i < w; i += 12) for (let j = 6; j < h; j += 14) { x.fillStyle = Math.random() < 0.35 ? '#ffe9a8' : '#6d5b45'; x.fillRect(i, j, 6, 8); }
    });
    for (let i = 0; i < 60; i++) {
      const a = rand(0, Math.PI * 2), d = rand(16, 70), h = rand(12, 38), w = rand(3, 7);
      const t = towerTex.clone(); t.needsUpdate = true; t.repeat.set(w / 4, h / 8);
      g.add(mesh(new THREE.BoxGeometry(w, h, w), std('#ffffff', { map: t, roughness: 0.85 }), Math.cos(a) * d, -75 + h / 2, Math.sin(a) * d, false));
      if (i % 3 === 0) {
        const cr = mesh(new THREE.OctahedronGeometry(0.9), glow('#57c7ff', 3), Math.cos(a) * d, -75 + h + 1.6, Math.sin(a) * d, false);
        animated.push(o => { cr.rotation.y = o.time; });
        g.add(cr);
      }
    }
    const crystal = mesh(new THREE.OctahedronGeometry(0.35), glow('#57c7ff', 3), 2.4, 3.65, -2.4, false);
    animated.push(o => { crystal.rotation.y = o.time; crystal.position.y = 3.65 + Math.sin(o.time * 2) * 0.08; });
    const cLight = new THREE.PointLight('#57c7ff', 6, 6);
    cLight.position.set(2.4, 3.4, -2.4);
    g.add(crystal, cLight, poro(7.6, 0, 0.5, -Math.PI / 2));
  }

  function decorGrind(g, map) {
    hemi.color.set('#cfe8d6'); hemi.groundColor.set('#1d2a22'); hemi.intensity = 0.8;
    sun.color.set('#fff0d0'); sun.intensity = 2.2; rim.color.set('#7dff9a');
    bloom.strength = 0.7; bloom.threshold = 0.95; renderer.toneMappingExposure = 0.9; scene.environmentIntensity = 0.3;
    g.add(sky('#0e1714', '#2e4a3a', '#101a15'));
    scene.fog = new THREE.Fog('#2a3f33', 22, 80);
    // the chem pit: glowing sludge, green light, rising fumes
    const sludge = mesh(new THREE.PlaneGeometry(4, 2.6).rotateX(-Math.PI / 2), glow('#7dff4f', 2.5), 0, -2.2, 0, false);
    const light = new THREE.PointLight('#7dff4f', 40, 10);
    light.position.set(0, -1, 0);
    g.add(sludge, light);
    animated.push(o => {
      light.intensity = 36 + Math.sin(o.time * 7) * 6;
      if (Math.random() < o.dt * 14) emit(new THREE.Vector3(rand(-1.8, 1.8), -1.5, rand(-1, 1)), { color: '#8dff5f', n: 1, speed: 0.6, size: 0.5, life: 1.4, grav: 2.2, spread: 0.2, up: 2, opacity: 0.6 });
    });
    // hazard stripes round the pit edge
    const k = map.kill[0];
    const stripe = hazardTex();
    for (const [x, z, w, d] of [[0, k.max[2] + 0.12, 4.2, 0.24], [0, k.min[2] - 0.12, 4.2, 0.24], [k.min[0] - 0.12, 0, 0.24, 2.6], [k.max[0] + 0.12, 0, 0.24, 2.6]]) {
      const t = stripe.clone(); t.needsUpdate = true;
      t.repeat.set(Math.max(w, d) / 0.5, 1);
      if (d > w) t.rotation = Math.PI / 2;
      g.add(mesh(new THREE.BoxGeometry(w, 0.02, d), std('#ffffff', { map: t, roughness: 0.7 }), x, 0.012, z));
    }
    // pipes along the side wall, a few smokestacks in the haze
    const pipe = std('#4f6f5a', { metalness: 0.6, roughness: 0.4 });
    for (const y of [0.5, 1.2]) { const m = mesh(new THREE.CylinderGeometry(0.12, 0.12, 10, 16), pipe, -6.85, y, 0); m.rotation.x = Math.PI / 2; g.add(m); }
    const stackMat = std('#3a4740', { roughness: 0.9 });
    for (const [x, z, h] of [[-16, -30, 30], [-5, -36, 38], [10, -32, 26], [22, -26, 34]]) {
      g.add(mesh(new THREE.CylinderGeometry(1.1, 1.6, h, 16), stackMat, x, h / 2 - 6, z, false));
      g.add(mesh(new THREE.TorusGeometry(1.15, 0.12, 6, 16).rotateX(Math.PI / 2), glow('#ff7a3d', 1.5), x, h - 7, z, false));
      animated.push(o => { if (Math.random() < o.dt * 3) emit(new THREE.Vector3(x, h - 5.5, z), { color: '#5b6b62', n: 1, speed: 0.8, size: 3, life: 3, grav: 0.8, spread: 0.2, up: 3, additive: false, opacity: 0.45 }); });
    }
    // hanging industrial lamps
    for (const x of [-3.5, 3.5]) {
      g.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 3), dark(), x, 5.5, 0, false));
      g.add(mesh(new THREE.ConeGeometry(0.45, 0.35, 16, 1, true), std('#2c3330', { side: THREE.DoubleSide }), x, 4, 0, false));
      g.add(mesh(new THREE.SphereGeometry(0.14), glow('#fff2c0', 3), x, 3.85, 0, false));
      const l = new THREE.PointLight('#ffe7b0', 14, 9);
      l.position.set(x, 3.7, 0);
      g.add(l);
    }
    // Jinx was here
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(4, 1), new THREE.MeshBasicMaterial({ transparent: true, map: canvasTex(1024, 256, (x) => {
      x.font = '900 150px Nunito, sans-serif'; x.textAlign = 'center'; x.lineWidth = 14;
      x.strokeStyle = '#2a7dff'; x.strokeText('JINX WAS HERE', 512, 175);
      x.fillStyle = '#ff4fb8'; x.fillText('JINX WAS HERE', 512, 175);
    }, false) }));
    tag.position.set(2.5, 0.45, -4.99); tag.rotation.z = 0.05;
    g.add(tag, poro(-6.5, 1.8, -4.4, 0.6));
    g.add(mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), std('#7a5a3a', { map: noiseTex('#7a5a3a', 0.15) }), 6.3, 0.35, -4.4));
    const hc = mesh(new THREE.OctahedronGeometry(0.18), glow('#57c7ff', 3), 6.3, 0.9, -4.4, false);
    animated.push(o => { hc.rotation.y = o.time * 1.5; });
    g.add(hc);
  }
  const dark = () => std('#2a2e33', { metalness: 0.6 });

  function poro(x, y, z, yaw) {
    const p = new THREE.Group();
    p.position.set(x, y, z); p.rotation.y = yaw;
    const fur = gummy('#f6f2ec', { roughness: 0.95, clearcoat: 0 });
    p.add(mesh(new THREE.SphereGeometry(0.3, 20, 14), fur, 0, 0.28, 0));
    for (const s of [-1, 1]) {
      const horn = mesh(new THREE.ConeGeometry(0.05, 0.18), std('#d9b98a'), s * 0.15, 0.55, 0);
      horn.rotation.z = -s * 0.5;
      p.add(horn, mesh(new THREE.SphereGeometry(0.045), std('#111', { roughness: 0.1 }), s * 0.1, 0.36, 0.26));
    }
    p.add(mesh(new THREE.SphereGeometry(0.07), gummy('#ff7aa0'), 0, 0.2, 0.28));
    animated.push(o => { p.scale.y = 1 + Math.sin(o.time * 3 + x) * 0.04; });
    return p;
  }

  // the Gang Beasts beast mesh, skinned to our part frames (bones ride along as children of the parts)
  function beastMeshes(parts, bodyMat, eyeMat) {
    const { json, body, head } = beastAsset;
    const at = buf => { let o = 0; return (T, n) => { const a = new T(buf, o, n); o += n * T.BYTES_PER_ELEMENT; return a; }; };
    let take = at(body), n = json.body.verts;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(take(Float32Array, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(take(Float32Array, n * 3), 3));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(take(Float32Array, n * 4), 4));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(take(Uint16Array, n * 4), 4));
    g.setIndex(new THREE.BufferAttribute(take(Uint32Array, json.body.indices), 1));
    const bones = json.body.bones.map(b => {
      let i = PARTS.findIndex(pt => b.name.startsWith(`actor_${pt.name}_`));
      if (i < 0) i = FORE + (b.name.includes('left') ? 0 : 1); // hand, finger and thumb bones ride on the forearm
      const pt = PARTS[i], iq = qinv(pt.q), bone = new THREE.Bone();
      bone.position.fromArray(qrot(iq, b.rest[0].map((v, k) => v - pt.p[k])));
      bone.quaternion.fromArray(qmul(iq, b.rest[1]));
      parts[i].add(bone);
      return bone;
    });
    const skinned = new THREE.SkinnedMesh(g, bodyMat);
    skinned.bind(new THREE.Skeleton(bones, json.body.bones.map(b => new THREE.Matrix4().fromArray(b.bind))), new THREE.Matrix4());
    skinned.frustumCulled = false;
    skinned.castShadow = skinned.receiveShadow = true;

    take = at(head); n = json.head.verts;
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(take(Float32Array, n * 3), 3));
    hg.setAttribute('normal', new THREE.BufferAttribute(take(Float32Array, n * 3), 3));
    hg.setIndex(new THREE.BufferAttribute(take(Uint32Array, json.head.indices), 1));
    json.head.groups.forEach(([start, count], i) => hg.addGroup(start, count, i));
    parts[HEAD].add(mesh(hg, [bodyMat, eyeMat]));
    return skinned;
  }

  // no import: draw the beast's own collision shapes as gummy blobs
  function blobMeshes(parts, bodyMat, eyeMat) {
    PARTS.forEach((pt, i) => pt.shapes.forEach(sh => {
      if (sh.ball < 0.03) return;
      const geo = sh.ball ? new THREE.SphereGeometry(sh.ball, 24, 16) : new THREE.CapsuleGeometry(sh.cap[0], sh.cap[1] * 2, 8, 16);
      if (sh.cap?.[2] === 'x') geo.rotateZ(Math.PI / 2);
      parts[i].add(mesh(geo, bodyMat, ...sh.c));
    }));
    for (const s of [-1, 1]) parts[HEAD].add(mesh(new THREE.SphereGeometry(0.045, 12, 8), eyeMat, s * 0.08, 0.2, 0.25, false));
    return null;
  }

  // part frames (beast.js): chest origin at the waist joint, chest centre +0.25 up; head origin at the neck, skull centre (0, .17, .06) r .21;
  // forearm/shin point down their local -y; fist at HAND, foot at (0, -.12, 0)
  function makeAvatar(champId, color, name, belt) {
    const c = CHAMPS[champId], group = new THREE.Group();
    const body = champId === 'blitz' ? std(c.body, { metalness: 0.6, roughness: 0.32 }) : gummy(c.body);
    const parts = PARTS.map(() => { const g = new THREE.Group(); group.add(g); return g; });
    const skinned = (beastAsset ? beastMeshes : blobMeshes)(parts, body, glow(c.eyes, 2.5));
    if (skinned) group.add(skinned);
    if (belt) parts[HIPS].add(mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32).rotateX(Math.PI / 2), gummy(color), 0, 0.04, 0)); // team belt
    const fists = [];
    for (const [n, part, tag] of PROPS[champId]) {
      const o = propScenes[`${champId}/${n}`]?.clone();
      if (!o) continue;
      o.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; m.material = m.material.clone(); } }); // own copy: to light up, and to fade
      parts[part].add(o);
      if (tag === 'fist') fists.push(o);
    }
    const skin = new Set(); // everything that fades see-through after a KO
    group.traverse(m => { if (m.isMesh) [].concat(m.material).forEach(x => skin.add(x)); });

    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, map: canvasTex(512, 96, (x) => {
      x.font = '900 64px Nunito, sans-serif'; x.textAlign = 'center'; x.lineWidth = 12; x.lineJoin = 'round';
      x.strokeStyle = '#0b1426'; x.strokeText(name, 256, 70); x.fillStyle = color; x.fillText(name, 256, 70);
    }, false) }));
    tag.scale.set(1.8, 0.34, 1);
    tag.renderOrder = 10;
    group.add(tag);

    const stars = new THREE.Group();
    for (let i = 0; i < 3; i++) stars.add(mesh(new THREE.OctahedronGeometry(0.07), glow('#ffd84a', 3), Math.cos(i * 2.1) * 0.3, 0, Math.sin(i * 2.1) * 0.3, false));
    group.add(stars);
    // Rampage swirl
    const swirl = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.05, 6, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: c.eyes, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(swirl);
    // Haymaker range on the floor while it charges, like League's indicator: the cone at full reach, its brighter centre
    // strip (hits harder) and a fill out to the reach wound up so far
    let hay = null;
    if (champId === 'sett') {
      const { range, cone, base, core } = c.abilities[0], back = base / Math.tan(cone); // the shape sim.js haymaker hits
      const mat = (o, col = '#ffb000') => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: o, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      const flat = g => g.rotateX(Math.PI / 2); // drawn in xy pointing +y; laid on the floor pointing +z
      // the cone between from and to metres past Sett, its point back behind him
      const sector = (from, to) => flat(new THREE.RingGeometry(back + from, back + to, 40, 1, Math.PI / 2 - cone, cone * 2).translate(0, -back, 0));
      hay = new THREE.Group();
      hay.add(new THREE.Mesh(sector(0, range), mat(0.12)));
      hay.add(new THREE.Mesh(sector(range - 0.06, range), mat(0.7)));
      hay.add(new THREE.Mesh(flat(new THREE.PlaneGeometry(core * 2, range * 0.95).translate(0, range * 0.475, 0)), mat(0.12, '#fff3b0')));
      hay.fill = new THREE.Mesh(sector(0, range), mat(0.22, '#ff8a00'));
      hay.reach = r => { r = Math.round(r * 20) / 20; if (r !== hay.fill.r) { hay.fill.r = r; hay.fill.geometry.dispose(); hay.fill.geometry = sector(0, r); } };
      hay.add(hay.fill);
      for (const m of hay.children) m.renderOrder = 5;
      hay.visible = false;
      group.add(hay);
    }
    return { group, parts, tag, stars, fists, swirl, hay, skin: [...skin], ghost: false, champId, glow: c.glow ?? '#ff8a00', torsoMat: body, glowBase: body.emissive.clone(), eyes: c.eyes, q: PARTS.map(() => [0, 0, 0, 1]), pos: PARTS.map(() => [0, 0, 0]) };
  }

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  // draw an interpolated state between snapshots a and b; `own` ({ slot, a, b, alpha }) draws one player from its own
  // pair of states instead (a predicting client's own champ)
  // shift: per slot, how far to draw the hips off the snapshots (game.js carryOn)
  function apply(a, b, alpha, own, shift) {
    if (!setup) return;
    const centre = new THREE.Vector3(), alive = [];
    b.p.forEach((pb, slot) => {
      let pa = a.p[slot], t = alpha;
      if (own?.slot === slot) { pa = own.a; pb = own.b; t = own.alpha; }
      const av = avatars[slot];
      av.group.visible = !!pb[1];
      if (!pb[1]) return;
      // snapshot: hips position + one rotation per part; rebuild the other positions down the joint chain
      const lerp = pa?.[1] ? t : 1, src = pa?.[1] ? pa : pb;
      for (let i = 0; i < PARTS.length; i++) {
        const o = 9 + i * 4;
        qa.set(src[o], src[o + 1], src[o + 2], src[o + 3]);
        qb.set(pb[o], pb[o + 1], pb[o + 2], pb[o + 3]);
        qa.slerp(qb, lerp).toArray(av.q[i]);
      }
      tmp.set(src[6], src[7], src[8]).lerp(tmp2.set(pb[6], pb[7], pb[8]), lerp).add(shift?.[slot] ? tmp2.fromArray(shift[slot]) : tmp2.set(0, 0, 0)).toArray(av.pos[HIPS]);
      for (const i of ORDER) {
        const par = PARTS[i].parent;
        if (par >= 0) { const a = qrot(av.q[par], ANCHOR[i]); av.pos[i] = av.pos[par].map((v, k) => v + a[k]); }
        av.parts[i].position.fromArray(av.pos[i]);
        av.parts[i].quaternion.fromArray(av.q[i]);
      }
      const flags = pb[3], head = av.parts[HEAD].position, torso = av.parts[CHEST].position;
      av.tag.position.copy(head).y += 0.65;
      if (av.hay) {
        // winding up: everyone sees it, locked to Sett's yaw (sent in the snapshot, so it doesn't sway with his body)
        const x = 9 + PARTS.length * 4;
        av.hay.visible = !!(flags & 64);
        if (av.hay.visible) {
          av.hay.position.set(torso.x, av.parts[HIPS].position.y - HIP_HEIGHT + 0.04, torso.z);
          av.hay.rotation.y = pb[x + 8] ?? 0;
          const { rangeMin, range } = CHAMPS.sett.abilities[0], k = (pb[x] ?? 0) / 100;
          av.hay.reach(rangeMin + (range - rangeMin) * k);
        }
      }
      av.stars.visible = !!(flags & 16); // stars only while knocked out
      av.stars.position.copy(head).y += 0.45;
      av.stars.rotation.y = time * 6;
      // empowered punch (4) or winding up an ability (64): fists glow in the champ's colour; otherwise their own glow comes back
      const lit = flags & 68;
      for (const f of av.fists) f.traverse(m => {
        const mt = m.material;
        if (!mt?.emissive) return;
        mt.userData.e0 ??= [mt.emissive.clone(), mt.emissiveIntensity];
        if (lit) { mt.emissive.set(av.glow); mt.emissiveIntensity = 2.2 + Math.sin(time * 18); } else { mt.emissive.copy(mt.userData.e0[0]); mt.emissiveIntensity = mt.userData.e0[1]; }
      });
      if (lit && av.fists.length && Math.random() < 0.5) emit(av.fists[Math.floor(Math.random() * 2)].getWorldPosition(tmp2), { color: av.glow, n: 1, speed: 0.6, size: 0.18, life: 0.35, grav: 3, up: 1 });
      av.torsoMat.emissive.copy(av.glowBase);
      if (flags & 2) {
        av.torsoMat.emissive.set('#2fffd0').multiplyScalar(0.35 + 0.25 * Math.sin(time * 20));
        emit(tmp.copy(torso).add(tmp2.set(rand(-0.3, 0.3), rand(-0.6, 0.2), rand(-0.3, 0.3))), { color: av.eyes, n: 2, speed: 0.3, size: 0.45, life: 0.45, grav: 0.5 });
      }
      av.swirl.visible = !!(flags & 1);
      const ghost = !!(flags & 32); // just up from a KO, untouchable: see-through
      if (ghost !== av.ghost) { av.ghost = ghost; for (const m of av.skin) { m.transparent = ghost; m.opacity = ghost ? 0.35 : 1; m.depthWrite = !ghost; m.needsUpdate = true; } }
      if (flags & 1) { av.swirl.position.copy(torso); av.swirl.rotation.y = time * 25; av.swirl.material.opacity = 0.4 + Math.random() * 0.3; }
      centre.add(torso);
      alive.push(torso);
    });

    // Blitz hooks: a chain of links from the owner's right fist. Lee Sin's wave: a hot yellow core in a cyan shell,
    // trailing cyan; it stays on whoever it marked, a pulsing cyan glow
    while (hookPool.length < b.h.length) {
      const links = new THREE.InstancedMesh(new THREE.TorusGeometry(0.06, 0.02, 4, 8), std('#c9ced6', { metalness: 0.9, roughness: 0.3 }), 40);
      const head = mesh(new THREE.SphereGeometry(0.2, 16, 10), glow('#ffb347', 2.5), 0, 0, 0, false);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), new THREE.MeshBasicMaterial({ color: '#4fe3ff', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      world.add(links, head, shell);
      hookPool.push({ links, head, shell });
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    hookPool.forEach((h, i) => {
      const d = b.h[i], o = d && a.h?.find(e => e[0] === d[0]); // the same hook in the older snapshot (one per champ)
      const champ = d && setup.players[d[0]]?.champ;
      h.head.visible = !!d && !!b.p[d[0]]?.[1]; h.links.visible = h.head.visible && champ !== 'lee'; h.shell.visible = false;
      if (!h.head.visible) return;
      // between the two snapshots like the bodies: it covers ~1m per snapshot, so drawn from the newer one it stepped
      if (o) h.head.position.set(o[1], o[2], o[3]).lerp(tmp2.set(d[1], d[2], d[3]), alpha); else h.head.position.set(d[1], d[2], d[3]);
      const c = champ === 'lee' ? (d[5] ? '#4fe3ff' : '#fff0a0') : champ === 'thresh' ? '#7dff9a' : '#ffb347'; // Thresh's hook glows green
      h.head.material.color.set(c); h.head.material.emissive.set(c);
      h.head.scale.setScalar(champ === 'lee' && d[5] ? 1.3 + 0.3 * Math.sin(time * 12) : 1);
      if (champ === 'lee') {
        if (d[5] || !o) return;
        // in flight: the shell stretched out along the way it's going, and a trail
        h.shell.visible = true;
        h.shell.position.copy(h.head.position);
        h.shell.quaternion.setFromUnitVectors(tmp.set(0, 0, 1), tmp2.set(d[1] - o[1], d[2] - o[2], d[3] - o[3]).normalize());
        h.shell.scale.set(1.8, 1.8, 2.8);
        emit(h.head.position, { color: Math.random() < 0.7 ? '#4fe3ff' : '#fff0a0', n: 1, speed: 0.4, size: 0.3, life: 0.3, grav: 0 });
        return;
      }
      const arm = avatars[d[0]].parts[FORE + 1]; // avatar groups sit at the origin, so part-local -> world is just the part's own transform
      const from = tmp.fromArray(HAND[1]).applyQuaternion(arm.quaternion).add(arm.position), dir = tmp2.subVectors(h.head.position, from);
      const n = Math.min(40, Math.max(1, Math.floor(dir.length() / 0.1)));
      q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      for (let k = 0; k < n; k++) {
        const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), k % 2 ? Math.PI / 2 : 0);
        m4.compose(from.clone().addScaledVector(dir, (k + 0.5) / n), q.clone().multiply(twist).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)), new THREE.Vector3(1, 1, 1));
        h.links.setMatrixAt(k, m4);
      }
      h.links.count = n;
      h.links.instanceMatrix.needsUpdate = true;
    });

    // Singed's glue puddles, fading out over their last second
    const gl = b.g ?? [];
    while (gluePool.length < gl.length) {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#a6ff00', transparent: true, depthWrite: false }));
      m.renderOrder = 4; world.add(m); gluePool.push(m);
    }
    gluePool.forEach((m, i) => {
      const g = gl[i];
      m.visible = !!g;
      if (g) { m.position.set(g[0], g[1] + 0.03, g[2]); m.scale.setScalar(g[4]); m.material.opacity = 0.5 * Math.min(1, g[3]); }
    });

    for (const { r, roller } of rollers) roller.rotation.x = r.spin * b.mt;

    // shared Gang Beasts camera: frame everyone still standing
    if (alive.length) {
      centre.divideScalar(alive.length);
      const spread = Math.max(...alive.map(p => Math.hypot(p.x - centre.x, p.z - centre.z)));
      centre.y = Math.max(centre.y - 0.6, -3);
      camAt.lerp(centre, 0.04);
      camDist += (Math.min(cam.max, Math.max(cam.min, 8 + spread * 1.6)) - camDist) * 0.04;
    }
  }

  // aiming, mine only: the cursor's point on the floor under my champ -> a world yaw, and a League-style skillshot
  // strip under my champ while an aimed ability is held (game.js; range 0 = no strip)
  const aimRay = new THREE.Raycaster(), aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), aimHit = new THREE.Vector3();
  const aimBar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5),
    new THREE.MeshBasicMaterial({ color: '#0ac8b9', transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  aimBar.renderOrder = 5; aimBar.visible = false; scene.add(aimBar);
  const aimBack = new THREE.Mesh(aimBar.geometry, aimBar.material.clone()); // the other half of a two-sided strip (Flay), dimmer
  aimBack.material.opacity = 0.15; aimBack.renderOrder = 5; aimBack.visible = false; scene.add(aimBack);
  // a spot-targeted ability (Singed Q): its range round my champ and the puddle where the cursor is
  const ringMat = aimBar.material.clone(); ringMat.side = THREE.DoubleSide;
  const aimRange = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64).rotateX(-Math.PI / 2), ringMat);
  const aimSpot = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#a6ff00', transparent: true, opacity: 0.35, depthWrite: false }));
  for (const m of [aimRange, aimSpot]) { m.renderOrder = 5; m.visible = false; scene.add(m); }
  let aim = null, aimD = 0; // aimD: the cursor's distance from my champ on the floor, from the last aimYaw()
  function aimYaw(cx, cy, slot) {
    const av = avatars[slot];
    if (!av) return null;
    const r = canvas.getBoundingClientRect(), hp = av.parts[HIPS].position;
    aimRay.setFromCamera(new THREE.Vector2((cx - r.left) / r.width * 2 - 1, 1 - (cy - r.top) / r.height * 2), camera);
    aimPlane.constant = HIP_HEIGHT - hp.y;
    if (!aimRay.ray.intersectPlane(aimPlane, aimHit)) return null;
    aimD = Math.hypot(aimHit.x - hp.x, aimHit.z - hp.z);
    return Math.atan2(aimHit.x - hp.x, aimHit.z - hp.z);
  }

  function render(dt) {
    time += dt;
    const spot = aim?.point && avatars[aim.slot];
    aimRange.visible = aimSpot.visible = !!spot;
    if (spot) {
      const hp = spot.parts[HIPS].position, y = hp.y - HIP_HEIGHT + 0.05, d = Math.min(aim.dist, aim.point.max);
      aimRange.position.set(hp.x, y, hp.z); aimRange.scale.setScalar(aim.point.max);
      aimSpot.position.set(hp.x + Math.sin(aim.yaw) * d, y, hp.z + Math.cos(aim.yaw) * d); aimSpot.scale.setScalar(aim.point.r);
    }
    const me = !spot && aim?.range && avatars[aim.slot];
    aimBar.visible = !!me;
    aimBack.visible = !!me && !!aim.back;
    if (me) {
      const hp = me.parts[HIPS].position;
      for (const [bar, yaw] of [[aimBar, aim.yaw], [aimBack, aim.yaw + Math.PI]]) { bar.position.set(hp.x, hp.y - HIP_HEIGHT + 0.05, hp.z); bar.rotation.y = yaw; bar.scale.set(0.7, 1, aim.range); }
    }
    for (const fn of animated) fn({ dt, time });
    stepParticles(dt);
    stepRings(dt);
    shake = Math.max(0, shake - dt * 1.2);
    const j = shake * shake * 1.5;
    // menu backdrop: the camera comes in closer and frames the brawl low and to the right, under the menu panel
    const d = setup?.menu ? camDist * 0.75 : camDist, ox = setup?.menu ? cam.side * d * 0.12 : 0, oy = setup?.menu ? d * 0.2 : 0;
    camera.position.set(camAt.x + ox + rand(-j, j), camAt.y + oy + d * Math.sin(cam.pitch) + rand(-j, j), camAt.z + cam.side * d * Math.cos(cam.pitch));
    camera.lookAt(camAt.x + ox, camAt.y + oy, camAt.z);
    aoCam.copy(camera); aoCam.layers.set(0);
    const skyMesh = world?.getObjectByName('sky');
    if (skyMesh) skyMesh.position.copy(camera.position);
    sun.position.copy(camAt).add(sunOffset);
    sun.target.position.copy(camAt);
    // shadow box just covers the view, so the map's texels go as far as they can
    const sc = sun.shadow.camera, half = Math.round(camDist * 0.85);
    if (sc.right !== half) { Object.assign(sc, { left: -half, right: half, top: half, bottom: -half }); sc.updateProjectionMatrix(); }
    rim.position.set(camAt.x - 6, camAt.y + 8, camAt.z - 14);
    composer.render(dt);
  }

  // a champ swapped mid-match (sim.js setChamp): rebuild that beast
  function setChamp(slot, champ) {
    const p = setup.players[slot];
    world.remove(avatars[slot].group);
    avatars[slot] = makeAvatar(champ, playerColor(setup, slot), p.name, !!setup.teams);
    world.add(avatars[slot].group);
  }

  return { setMatch, setChamp, apply, fx, render, aimYaw, aimDist: () => aimD, setAim: a => { aim = a; }, avatars: () => avatars, get camSide() { return cam.side; } };
}
