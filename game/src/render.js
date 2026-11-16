// EMBERLINE — render.js
// The dusk look: a low warm sun, long shadows, purple-orange fog, and a
// container yard painted in rust, teal and ochre. All art is procedural —
// boxes with canvas textures, no fetched assets — so the game runs offline
// from static files. The renderer owns three.js only; the sim never sees it.

import * as THREE from 'three';
import { OBSTACLES, SITES, WORLD } from './world.js';

const TEAM_COLOR = { ember: 0xff7a1a, vanguard: 0x2fb7ff };
const TEAM_DARK = { ember: 0x7a2d05, vanguard: 0x0b3d5c };

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Asphalt with lane markings, hazard stripes and yard grime. */
function groundTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    g.fillStyle = '#33302e'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5200; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.05)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // Lane dashes down the middle of the yard.
    g.strokeStyle = 'rgba(255,190,80,0.5)'; g.lineWidth = 5; g.setLineDash([34, 26]);
    g.beginPath(); g.moveTo(60, h / 2); g.lineTo(w - 60, h / 2); g.stroke();
    g.setLineDash([]);
    // Yard border.
    g.strokeStyle = 'rgba(255,190,80,0.35)'; g.lineWidth = 8;
    g.strokeRect(14, 14, w - 28, h - 28);
    // Container shadows / oil stains.
    for (let i = 0; i < 26; i++) {
      g.fillStyle = 'rgba(0,0,0,0.20)';
      g.beginPath();
      g.ellipse(Math.random() * w, Math.random() * h, 20 + Math.random() * 50, 12 + Math.random() * 26, Math.random() * 3, 0, 7);
      g.fill();
    }
  });
}

/** A site decal: a painted circle with a big letter, laid on the ground. */
function siteTexture(site) {
  const col = site.id === 'A' ? '#ffb020' : '#27d3ff';
  return canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = col; g.lineWidth = 10;
    g.beginPath(); g.arc(128, 128, 108, 0, 7); g.stroke();
    g.fillStyle = col; g.globalAlpha = 0.16;
    g.beginPath(); g.arc(128, 128, 104, 0, 7); g.fill();
    g.globalAlpha = 1;
    g.font = 'bold 120px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(site.id, 128, 134);
  });
}

/** A floating name tag sprite for a bot. */
function nameTexture(name, team) {
  return canvasTexture(256, 48, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.font = 'bold 26px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = team === 'ember' ? '#ff9a3d' : '#6fd3ff';
    g.fillText(name.toUpperCase(), 128, 24);
  });
}

/** Corrugated container face: vertical ribs and rust streaks. */
function containerTexture(base) {
  const hex = '#' + base.toString(16).padStart(6, '0');
  return canvasTexture(256, 128, (g, w, h) => {
    g.fillStyle = hex; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 16) {
      g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x, 0, 5, h);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(x + 5, 0, 3, h);
    }
    for (let i = 0; i < 30; i++) {
      g.fillStyle = 'rgba(30,10,0,0.18)';
      g.fillRect(Math.random() * w, 0, 3 + Math.random() * 6, 20 + Math.random() * 80);
    }
    g.fillStyle = 'rgba(255,255,255,0.14)'; g.fillRect(0, 0, w, 6);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, h - 8, w, 8);
  });
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x2c1e33, 26, 78);
  scene.background = new THREE.Color(0x241a2e);

  // Dusk sky: a huge gradient dome (BackSide) so the horizon glows orange.
  const skyTex = canvasTexture(16, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1b1030');
    grad.addColorStop(0.45, '#4b2547');
    grad.addColorStop(0.72, '#b45a2e');
    grad.addColorStop(0.85, '#ff8c3a');
    grad.addColorStop(1, '#2c1e33');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(160, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
  );
  scene.add(sky);

  // Low warm sun from the west, long shadows across the yard.
  const sun = new THREE.DirectionalLight(0xff9a4d, 2.9);
  sun.position.set(-38, 14, -18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -30; sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30; sun.shadow.camera.bottom = -30;
  sun.shadow.camera.far = 120;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x7a5a9e, 0x241a16, 1.05));
  // Site glow lights.
  for (const s of Object.values(SITES)) {
    const p = new THREE.PointLight(s.color, 14, 16, 1.8);
    p.position.set(s.x, 3.2, s.z);
    scene.add(p);
  }

  // Ground.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 38),
    new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.94, metalness: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Perimeter walls.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.9 });
  const mkWall = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, WORLD.wallH, d), wallMat);
    m.position.set(x, WORLD.wallH / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
  };
  mkWall(46, 1, 0, -18.5); mkWall(46, 1, 0, 18.5);
  mkWall(1, 38, -22.5, 0); mkWall(1, 38, 22.5, 0);

  // Containers and crates from the world data.
  const texCache = new Map();
  for (const o of OBSTACLES) {
    if (!texCache.has(o.color)) texCache.set(o.color, containerTexture(o.color));
    const w = o.x1 - o.x0, d = o.z1 - o.z0;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, o.h, d),
      new THREE.MeshStandardMaterial({ map: texCache.get(o.color), roughness: 0.82, metalness: 0.12 }),
    );
    mesh.position.set((o.x0 + o.x1) / 2, o.h / 2, (o.z0 + o.z1) / 2);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);
    // Top rim highlight so boxes read at dusk.
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.06, 0.08, d + 0.06),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3, emissive: 0x332211, emissiveIntensity: 0.4 }),
    );
    rim.position.set(mesh.position.x, o.h + 0.02, mesh.position.z);
    scene.add(rim);
  }

  // Site decals + floating letters + light beams.
  for (const s of Object.values(SITES)) {
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD.siteRadius * 2, WORLD.siteRadius * 2),
      new THREE.MeshBasicMaterial({ map: siteTexture(s), transparent: true, depthWrite: false }),
    );
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(s.x, 0.03, s.z);
    scene.add(decal);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.9, 9, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.position.set(s.x, 4.5, s.z);
    scene.add(beam);
  }

  // Camera + viewmodel gun.
  const camera = new THREE.PerspectiveCamera(78, 1, 0.08, 220);
  scene.add(camera);
  const gun = buildViewmodel(camera);

  // Muzzle flash light + sprite (shared, repositioned per shot). The sprite
  // is a billboard, so the flash reads from the shooter's own view.
  const flashLight = new THREE.PointLight(0xffc46b, 0, 3.5, 2);
  scene.add(flashLight);
  // A faint warm light on the camera so the viewmodel always reads at dusk.
  const gunLight = new THREE.PointLight(0xffd9a0, 0.9, 2.5, 1.5);
  gunLight.position.set(0.25, 0.15, -0.2);
  camera.add(gunLight);
  const flashTex = canvasTexture(128, 128, (g, w, h) => {
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,230,160,1)');
    grad.addColorStop(0.35, 'rgba(255,180,70,0.85)');
    grad.addColorStop(1, 'rgba(255,120,20,0)');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
  });
  const flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flashTex, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  flashSprite.scale.set(0.35, 0.35, 1);
  scene.add(flashSprite);

  // Tracer pool: 24 reusable lines.
  const tracers = [];
  for (let i = 0; i < 24; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 0 }));
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }

  // Impact spark pool: one Points cloud, 240 particles, recycled.
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(240 * 3);
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: 0xffd27a, size: 0.09, transparent: true, opacity: 0.95 }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  const sparkVel = new Float32Array(240 * 3);
  let sparkCursor = 0, sparkLife = 0;

  // Explosion mesh (hidden until a blast).
  const blast = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0, depthWrite: false }),
  );
  scene.add(blast);
  const blastLight = new THREE.PointLight(0xff7a1a, 0, 30, 1.6);
  scene.add(blastLight);

  // Charge mesh: a small blinking case, carried or on the ground.
  const charge = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.26, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.6, emissive: 0xff2200, emissiveIntensity: 0.6 }),
  );
  charge.castShadow = true;
  scene.add(charge);

  return {
    renderer, scene, camera, gun, flashLight, flashSprite, tracers,
    sparks, sparkGeo, sparkPos, sparkVel, sparkCursor: () => sparkCursor,
    blast, blastLight, charge, bots: new Map(),
    flashT: 0, blastT: 0, shake: 0,
    setSparkCursor(v) { sparkCursor = v; },
    setSparkLife(v) { sparkLife = v; },
    sparkLife: () => sparkLife,
  };
}

/** A boxy rifle viewmodel attached to the camera, with a muzzle tip. */
function buildViewmodel(camera) {
  const gun = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x33333a, roughness: 0.45, metalness: 0.7 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.4, emissive: 0xff7a1a, emissiveIntensity: 0.25 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.62), dark);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), dark);
  barrel.position.set(0, 0.03, -0.46);
  const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.1), dark);
  mag.position.set(0, -0.13, -0.08);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, 0.12), accent);
  sight.position.set(0, 0.1, -0.12);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.08), dark);
  grip.position.set(0, -0.12, 0.16);
  gun.add(body, barrel, mag, sight, grip);
  gun.position.set(0.22, -0.2, -0.45);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.03, -0.66);
  gun.add(muzzle);
  gun.userData.muzzle = muzzle;
  camera.add(gun);
  return gun;
}

/** Create (or fetch) a bot's mesh: body, head, visor, gun, name tag. */
export function botMesh(r, agent) {
  let m = r.bots.get(agent.id);
  if (m) return m;
  const team = agent.team;
  const g = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: TEAM_DARK[team], roughness: 0.7, metalness: 0.2 });
  const trim = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.5, metalness: 0.3, emissive: TEAM_COLOR[team], emissiveIntensity: 0.65 });
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.85, 10), suit);
  torso.position.y = 1.0;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.3), trim);
  chest.position.set(0, 1.15, 0.16);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 10), suit);
  head.position.y = 1.66;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.09, 0.1), trim);
  visor.position.set(0, 1.68, 0.2);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.3), suit);
  legs.position.y = 0.28;
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.7), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.4, metalness: 0.7 }));
  gun.position.set(0.22, 1.15, 0.3);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTexture(agent.name, team), transparent: true, depthWrite: false }));
  tag.scale.set(1.5, 0.28, 1);
  tag.position.y = 2.15;
  g.add(torso, chest, head, visor, legs, gun, tag);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
  g.userData.tag = tag;
  g.userData.head = head;
  r.scene.add(g);
  r.bots.set(agent.id, g);
  return g;
}

/** World position of the viewmodel gun's muzzle tip (for the player's flash). */
const _tip = new THREE.Vector3();
export function gunTipWorld(r) {
  r.gun.userData.muzzle.getWorldPosition(_tip);
  return [_tip.x, _tip.y, _tip.z];
}

/** Fire a tracer from `from` to `to`, plus a muzzle flash at `from`. */
export function spawnTracer(r, from, to, color) {
  for (const t of r.tracers) {
    if (t.life > 0) continue;
    const pos = t.line.geometry.attributes.position.array;
    pos[0] = from[0]; pos[1] = from[1]; pos[2] = from[2];
    pos[3] = to[0]; pos[4] = to[1]; pos[5] = to[2];
    t.line.geometry.attributes.position.needsUpdate = true;
    t.line.material.color.setHex(color);
    t.line.material.opacity = 0.9;
    t.life = 0.35;
    return;
  }
}

export function spawnMuzzle(r, worldPos) {
  r.flashLight.position.set(worldPos[0], worldPos[1], worldPos[2]);
  r.flashLight.intensity = 8;
  r.flashSprite.position.set(worldPos[0], worldPos[1], worldPos[2]);
  r.flashSprite.material.opacity = 0.7;
  r.flashT = 0.25;
}

/** A burst of impact sparks at a point. */
export function spawnSparks(r, p, n = 14) {
  for (let i = 0; i < n; i++) {
    const idx = r.sparkCursor() % 240;
    r.setSparkCursor(r.sparkCursor() + 1);
    const a = Math.random() * Math.PI * 2, up = Math.random() * 2 - 0.4;
    const sp = 2 + Math.random() * 4;
    r.sparkPos[idx * 3] = p[0];
    r.sparkPos[idx * 3 + 1] = p[1];
    r.sparkPos[idx * 3 + 2] = p[2];
    r.sparkVel[idx * 3] = Math.cos(a) * sp;
    r.sparkVel[idx * 3 + 1] = up * sp;
    r.sparkVel[idx * 3 + 2] = Math.sin(a) * sp;
  }
  r.setSparkLife(0.5);
  r.sparkGeo.attributes.position.needsUpdate = true;
}

/** Trigger the detonation visual at a site. */
export function spawnBlast(r, p) {
  r.blast.position.set(p[0], 0.6, p[1]);
  r.blastT = 0.9;
  r.blastLight.position.set(p[0], 2, p[1]);
  r.blastLight.intensity = 90;
  r.shake = 1;
}

/** Per-frame render update: cameras, bot meshes, effects decay. */
export function renderFrame(r, s, dt, time) {
  const p = s.player;
  const cam = r.camera;
  // Camera shake decays; the view follows the player's eye.
  r.shake = Math.max(0, r.shake - dt * 2.2);
  const shx = (Math.random() - 0.5) * 0.09 * r.shake;
  const shy = (Math.random() - 0.5) * 0.09 * r.shake;
  cam.position.set(p.x + shx, p.eyeY + shy, p.z);
  // The sim's yaw measures forward as (sin yaw, -cos yaw); three.js turns
  // a camera by rotation.y with the opposite sign, so negate it here.
  cam.rotation.set(p.pitch, -p.yaw, 0, 'YXZ');
  // Viewmodel: walk bob, recoil kick, scope tuck.
  const bob = Math.sin(time * 9) * 0.012 * Math.min(1, p.speed / 4);
  const kick = p.weapon ? p.weapon.recoilPitch * 0.02 : 0;
  r.gun.position.set(0.22 + bob * 0.4, -0.2 + Math.abs(bob) - kick * 0.5, -0.45 + kick);
  r.gun.rotation.x = kick * 1.4;
  r.gun.visible = !s.scoped;

  // Bots: position, yaw, crouch, death fall.
  for (const a of s.agents) {
    if (a.isPlayer) continue;
    const m = botMesh(r, a);
    m.visible = true;
    m.position.set(a.x, a.y, a.z);
    // The bot model faces +z at rest; rotate it onto the sim's forward
    // (sin yaw, -cos yaw), which three.js reaches with rotation.y = PI - yaw.
    m.rotation.y = Math.PI - a.yaw;
    const targetScaleY = a.alive ? (a.crouched ? 0.78 : 1) : 0.12;
    m.scale.y += (targetScaleY - m.scale.y) * Math.min(1, dt * 10);
    m.userData.tag.visible = a.alive;
    // A dead bot lies flat: rotate the group once it is down.
    m.rotation.x = a.alive ? 0 : -Math.PI / 2 * (1 - m.scale.y);
  }

  // The charge: blinking case on its holder, on the ground, or at the site.
  const c = s.charge;
  const blink = (Math.sin(time * 9) > 0) ? 1.4 : 0.25;
  r.charge.material.emissiveIntensity = blink;
  if (c.state === 'carried' && c.holder) {
    r.charge.position.set(c.holder.x, 1.05 + c.holder.y, c.holder.z + 0.1);
    r.charge.visible = true;
  } else if (c.state === 'dropped' || c.state === 'planted' || c.state === 'defusing') {
    r.charge.position.set(c.x, c.state === 'planted' ? 0.16 : 0.3, c.z);
    r.charge.visible = true;
  } else {
    r.charge.visible = false;
  }

  // Muzzle flash decay.
  if (r.flashT > 0) {
    r.flashT -= dt;
    if (r.flashT <= 0) { r.flashLight.intensity = 0; r.flashSprite.material.opacity = 0; }
  }
  // Tracers fade.
  for (const t of r.tracers) {
    if (t.life <= 0) continue;
    t.life -= dt;
    t.line.material.opacity = Math.max(0, t.life / 0.35) * 0.9;
  }
  // Sparks fly and fall.
  if (r.sparkLife() > 0) {
    r.setSparkLife(r.sparkLife() - dt);
    for (let i = 0; i < 240; i++) {
      r.sparkVel[i * 3 + 1] -= 6 * dt;
      r.sparkPos[i * 3] += r.sparkVel[i * 3] * dt;
      r.sparkPos[i * 3 + 1] = Math.max(0.02, r.sparkPos[i * 3 + 1] + r.sparkVel[i * 3 + 1] * dt);
      r.sparkPos[i * 3 + 2] += r.sparkVel[i * 3 + 2] * dt;
    }
    r.sparkGeo.attributes.position.needsUpdate = true;
  }
  // Blast expands and fades.
  if (r.blastT > 0) {
    r.blastT -= dt;
    const k = 1 - r.blastT / 0.9;
    r.blast.scale.setScalar(1 + k * 9);
    r.blast.material.opacity = Math.max(0, 0.85 * (1 - k));
    r.blastLight.intensity = Math.max(0, 90 * (1 - k));
  }

  r.renderer.render(r.scene, cam);
}

export function resizeRenderer(r, w, h) {
  r.renderer.setSize(w, h, false);
  r.camera.aspect = w / h;
  r.camera.updateProjectionMatrix();
}
