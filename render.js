// Three.js view of a match. Knows nothing about physics: it draws whatever snapshots it's given.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAPS } from './maps.js';
import { CHAMPS, TEAM_COLORS, FFA_COLORS } from './champs.js';
import { PARTS, ORDER, ANCHOR, HAND, CHEST, HEAD, FORE, HIPS, qmul, qinv, qrot } from './beast.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { beastAsset, xhr } from './stages.js';
import { playEvents } from './sfx.js';

// Champion props, remade Gang Beasts style in Blender (tools/model_props.py -> assets/props/). Each is modelled in its
// part's frame, so it parents with no offset. [prop, part, tag]
const PROPS = {
  blitz: [['core', CHEST], ['gauntletL', FORE, 'fist'], ['gauntletR', FORE + 1, 'fist']],
  hec: [['blade', HEAD], ['tail', HIPS]],
};
const PROP_FILE = { blitz: 'blitzcrank', hec: 'hecarim' };
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
  uniforms: { tDiffuse: { value: null }, strength: { value: 0.35 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv;
    void main() { vec4 c = texture2D(tDiffuse, vUv); float d = distance(vUv, vec2(0.5)); c.rgb *= 1.0 - strength * smoothstep(0.35, 0.85, d); gl_FragColor = c; }`,
};

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);

  // HDR render target with MSAA, bloom on the bright bits, then tone map + vignette
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(VignetteShader));
  const resize = () => {
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize); resize();

  const hemi = new THREE.HemisphereLight('#fff4e0', '#4a4060', 1.1);
  const sun = new THREE.DirectionalLight('#fff1d6', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 80 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 4;
  const rim = new THREE.DirectionalLight('#9ad8ff', 0.9); // cool back light so silhouettes pop
  scene.add(hemi, sun, sun.target, rim);

  let world = null, avatars = [], rollers = [], hookPool = [], setup = null, animated = [];
  const camAt = new THREE.Vector3(0, 0, 0);
  let camDist = 14, shake = 0, time = 0;
  const sunOffset = new THREE.Vector3(8, 20, 6);
  let cam = { side: 1, pitch: 0.63, min: 10, max: 24 }; // side -1 = camera on the -z side, looking +z
  // calibration knobs for imported Unity lighting (URP intensities don't map 1:1 onto three.js)
  const LIGHTMAP_GAIN = 2.2, SUN_GAIN = 2.2, AMBIENT_GAIN = 3;

  // ---------- particles ----------
  const particles = [];
  const pGroup = new THREE.Group();
  scene.add(pGroup);
  function emit(pos, { color = '#fff', n = 8, speed = 4, size = 0.25, life = 0.5, grav = -6, spread = 1, up = 0, additive = true, opacity = 1 }) {
    for (let i = 0; i < n; i++) {
      let p = particles.find(q => q.life <= 0);
      if (!p) {
        if (particles.length > 400) return;
        p = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, depthWrite: false })) };
        pGroup.add(p.sprite);
        particles.push(p);
      }
      const d = new THREE.Vector3(rand(-1, 1), rand(-1, 1) * spread + up, rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      Object.assign(p, { vel: d, life: life * rand(0.7, 1.2), max: life, size: size * rand(0.7, 1.3), grav, opacity });
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
      p.sprite.scale.setScalar(p.size * (0.5 + k * 0.7));
    }
  }
  const rings = [];
  function ring(pos, color, size) {
    let r = rings.find(q => q.life <= 0);
    if (!r) {
      r = { m: new THREE.Mesh(new THREE.RingGeometry(0.7, 1, 32), new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })) };
      scene.add(r.m); rings.push(r);
    }
    r.m.position.copy(pos); r.m.quaternion.copy(camera.quaternion);
    r.m.material.color.set(color);
    Object.assign(r, { life: 0.3, size });
    r.m.visible = true;
  }
  function stepRings(dt) {
    for (const r of rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      r.m.visible = r.life > 0;
      const k = 1 - r.life / 0.3;
      r.m.scale.setScalar(r.size * (0.2 + k));
      r.m.material.opacity = 1 - k;
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
    avatars = s.players.map((p, slot) => { const a = makeAvatar(p.champ, playerColor(s, slot), p.name); world.add(a.group); return a; });
    hookPool = [];
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
  function buildImported(g, { scene: sc, bins, base }) {
    const loader = new THREE.TextureLoader(), texCache = {};
    // per-renderer lightmap tiling needs a texture clone each; clone only once the image exists
    const lmWaiting = [];
    const lightmapTex = sc.lightmaps[0] && loader.load(base + sc.lightmaps[0], t => { for (const fn of lmWaiting.splice(0)) fn(t); });
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
    const material = (key, lm) => {
      const id = key + (lm ? lm.join() : '');
      if (mats[id]) return mats[id];
      const d = sc.materials[key];
      const m = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setRGB(d.color[0], d.color[1], d.color[2], THREE.SRGBColorSpace),
        map: d.map ? tex(d.map) : null, roughness: 1 - d.smoothness * 0.8, metalness: d.metallic,
      });
      if (d.emission && Math.max(...d.emission) > 0) m.emissive.setRGB(...d.emission.map(v => Math.min(v, 1)));
      if (lm && lightmapTex) {
        const attach = t => {
          const c = t.clone();
          c.colorSpace = THREE.SRGBColorSpace; c.channel = 1;
          c.repeat.set(lm[0], lm[1]); c.offset.set(lm[2], lm[3]);
          m.lightMap = c; m.lightMapIntensity = LIGHTMAP_GAIN; m.needsUpdate = true;
        };
        if (lightmapTex.image) attach(lightmapTex); else lmWaiting.push(attach);
      }
      return (mats[id] = m);
    };
    for (const r of sc.renderers) {
      const src = geos[r.mesh], meta = sc.meshes[r.mesh];
      const geo = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(src.attributes)) geo.setAttribute(k, a);
      geo.setIndex(src.index);
      r.subs.forEach((s, i) => { if (meta.subs[s]) geo.addGroup(meta.subs[s][0], meta.subs[s][1], Math.min(i, r.mats.length - 1)); });
      const lm = r.lightmap >= 0 && meta.uv1 ? r.lmso : null;
      const m = new THREE.Mesh(geo, r.mats.map(k => material(k, lm)));
      if (r.matrix) { m.matrixAutoUpdate = false; m.matrix.set(...r.matrix.flat()); }
      const city = r.path.includes('/City');
      m.castShadow = !city; m.receiveShadow = !city;
      m.frustumCulled = false; // groups share the full combined bounding volume anyway
      g.add(m);
    }
    const e = sc.env ?? {};
    if (e.ambientSky) { hemi.color.setRGB(...e.ambientSky, THREE.SRGBColorSpace); hemi.groundColor.setRGB(...e.ambientGround, THREE.SRGBColorSpace); hemi.intensity = AMBIENT_GAIN; }
    if (e.sun) {
      sun.color.setRGB(...e.sun.color, THREE.SRGBColorSpace); sun.intensity = e.sun.intensity * SUN_GAIN;
      sunOffset.set(...e.sun.dir).normalize().multiplyScalar(-30);
    }
    rim.intensity = 0.4;
    bloom.strength = 0.25; bloom.threshold = 1.4; renderer.toneMappingExposure = 1; scene.environmentIntensity = 0.35;
    scene.fog = null;
    g.add(sky('#6fb2ee', '#d8ecfa', '#b9c9d6'));
    cam = { side: -1, pitch: 27 * Math.PI / 180, min: 17, max: 28 }; // the stage's own camera looks from -z at 27 degrees
    g.add(poro(-4.6, 0, -3.2, 0.8)); // easter egg on the ground floor
  }

  function buildMap(g, map, id) {
    sunOffset.set(8, 20, 6);
    cam = { side: 1, pitch: 0.63, min: 10, max: 24 };
    if (map.imported) { buildImported(g, map.imported); return []; }
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
      x.font = 'bold 150px "Lilita One", sans-serif'; x.textAlign = 'center'; x.lineWidth = 14;
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
  function makeAvatar(champId, color, name) {
    const c = CHAMPS[champId], group = new THREE.Group();
    const body = champId === 'blitz' ? std(c.body, { metalness: 0.6, roughness: 0.32 }) : gummy(c.body);
    const parts = PARTS.map(() => { const g = new THREE.Group(); group.add(g); return g; });
    const skinned = (beastAsset ? beastMeshes : blobMeshes)(parts, body, glow(c.eyes, 2.5));
    if (skinned) group.add(skinned);
    parts[HIPS].add(mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 32).rotateX(Math.PI / 2), gummy(color), 0, 0.04, 0)); // team belt
    const fists = [];
    for (const [n, part, tag] of PROPS[champId]) {
      const o = propScenes[`${champId}/${n}`]?.clone();
      if (!o) continue;
      o.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; if (tag) m.material = m.material.clone(); } });
      parts[part].add(o);
      if (tag === 'fist') fists.push(o);
    }

    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, map: canvasTex(512, 96, (x) => {
      x.font = '64px "Lilita One", sans-serif'; x.textAlign = 'center'; x.lineWidth = 12; x.lineJoin = 'round';
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
    return { group, parts, tag, stars, fists, swirl, champId, torsoMat: body, glowBase: body.emissive.clone(), eyes: c.eyes, q: PARTS.map(() => [0, 0, 0, 1]), pos: PARTS.map(() => [0, 0, 0]) };
  }

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  // draw an interpolated state between snapshots a and b
  function apply(a, b, alpha) {
    if (!setup) return;
    const centre = new THREE.Vector3(), alive = [];
    b.p.forEach((pb, slot) => {
      const av = avatars[slot], pa = a.p[slot];
      av.group.visible = !!pb[1];
      if (!pb[1]) return;
      // snapshot: hips position + one rotation per part; rebuild the other positions down the joint chain
      const lerp = pa?.[1] ? alpha : 1, src = pa?.[1] ? pa : pb;
      for (let i = 0; i < PARTS.length; i++) {
        const o = 9 + i * 4;
        qa.set(src[o], src[o + 1], src[o + 2], src[o + 3]);
        qb.set(pb[o], pb[o + 1], pb[o + 2], pb[o + 3]);
        qa.slerp(qb, lerp).toArray(av.q[i]);
      }
      tmp.set(src[6], src[7], src[8]).lerp(tmp2.set(pb[6], pb[7], pb[8]), lerp).toArray(av.pos[HIPS]);
      for (const i of ORDER) {
        const par = PARTS[i].parent;
        if (par >= 0) { const a = qrot(av.q[par], ANCHOR[i]); av.pos[i] = av.pos[par].map((v, k) => v + a[k]); }
        av.parts[i].position.fromArray(av.pos[i]);
        av.parts[i].quaternion.fromArray(av.q[i]);
      }
      const flags = pb[3], head = av.parts[HEAD].position, torso = av.parts[CHEST].position;
      av.tag.position.copy(head).y += 0.65;
      const dizzy = flags & 16 ? 3 : pb[2] >= 60 ? 2 : 0;
      av.stars.visible = dizzy > 0;
      av.stars.children.forEach((s, i) => { s.visible = i < dizzy; });
      av.stars.position.copy(head).y += 0.45;
      av.stars.rotation.y = time * 6;
      for (const f of av.fists) f.traverse(m => { if (m.material?.emissive) { m.material.emissive.set(flags & 4 ? '#ff8a00' : '#000'); m.material.emissiveIntensity = flags & 4 ? 2.2 + Math.sin(time * 18) : 1; } });
      if (flags & 4 && av.fists.length && Math.random() < 0.5) emit(av.fists[Math.floor(Math.random() * 2)].getWorldPosition(tmp2), { color: '#ff9a2e', n: 1, speed: 0.6, size: 0.18, life: 0.35, grav: 3, up: 1 });
      av.torsoMat.emissive.copy(av.glowBase);
      if (flags & 2) {
        av.torsoMat.emissive.set('#2fffd0').multiplyScalar(0.35 + 0.25 * Math.sin(time * 20));
        emit(tmp.copy(torso).add(tmp2.set(rand(-0.3, 0.3), rand(-0.6, 0.2), rand(-0.3, 0.3))), { color: av.eyes, n: 2, speed: 0.3, size: 0.45, life: 0.45, grav: 0.5 });
      }
      av.swirl.visible = !!(flags & 1);
      if (flags & 1) { av.swirl.position.copy(torso); av.swirl.rotation.y = time * 25; av.swirl.material.opacity = 0.4 + Math.random() * 0.3; }
      centre.add(torso);
      alive.push(torso);
    });

    // Blitz hooks: a chain of links from the owner's right fist
    while (hookPool.length < b.h.length) {
      const links = new THREE.InstancedMesh(new THREE.TorusGeometry(0.06, 0.02, 4, 8), std('#c9ced6', { metalness: 0.9, roughness: 0.3 }), 40);
      const head = mesh(new THREE.SphereGeometry(0.2, 16, 10), glow('#ffb347', 2.5), 0, 0, 0, false);
      world.add(links, head);
      hookPool.push({ links, head });
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    hookPool.forEach((h, i) => {
      const d = b.h[i];
      h.links.visible = h.head.visible = !!d && !!b.p[d[0]]?.[1];
      if (!h.links.visible) return;
      h.head.position.set(d[1], d[2], d[3]);
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

  function render(dt) {
    time += dt;
    for (const fn of animated) fn({ dt, time });
    stepParticles(dt);
    stepRings(dt);
    shake = Math.max(0, shake - dt * 1.2);
    const j = shake * shake * 1.5;
    camera.position.set(camAt.x + rand(-j, j), camAt.y + camDist * Math.sin(cam.pitch) + rand(-j, j), camAt.z + cam.side * camDist * Math.cos(cam.pitch));
    camera.lookAt(camAt);
    const skyMesh = world?.getObjectByName('sky');
    if (skyMesh) skyMesh.position.copy(camera.position);
    sun.position.copy(camAt).add(sunOffset);
    sun.target.position.copy(camAt);
    rim.position.set(camAt.x - 6, camAt.y + 8, camAt.z - 14);
    composer.render(dt);
  }

  return { setMatch, apply, fx, render, get camSide() { return cam.side; } };
}
