// Effects: tracers, grenades and explosions. All pools are pre-allocated and reused;
// the hot loop never allocates. Tracers are thin stretched boxes that fade in 80 ms.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const MAX_TRACERS = 24;
const TRACER_LIFE = 0.09;
const MAX_GRENADES = 4;
const GRENADE_FUSE = 1.4;
const GRENADE_RADIUS = 5.5;
const GRENADE_DAMAGE = 95;
const GRAVITY = 12;

export function createFx(scene, colliders) {
  const tracers = [];
  const tracerMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.7,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < MAX_TRACERS; i += 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 1), tracerMat);
    mesh.visible = false;
    scene.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let tracerCursor = 0;

  const grenades = [];
  const grenadeGeo = new THREE.SphereGeometry(0.09, 10, 8);
  const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0x2e4a2e), roughness: 0.6, metalness: 0.4 });
  for (let i = 0; i < MAX_GRENADES; i += 1) {
    const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
    mesh.visible = false;
    mesh.castShadow = true;
    scene.add(mesh);
    grenades.push({ mesh, active: false, velocity: new THREE.Vector3(), fuse: 0 });
  }

  const blast = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, depthWrite: false }),
  );
  blast.visible = false;
  scene.add(blast);
  const blastLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 18);
  scene.add(blastLight);
  let blastLife = 0;
  let blastRadius = 0;

  const probe = new THREE.Box3();
  const tmp = new THREE.Vector3();

  function addTracer(from, to) {
    const entry = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
    tmp.subVectors(to, from);
    const fullLength = tmp.length() || 0.01;
    // Skip the first stretch near the shooter: a line that starts at the
    // camera reads as a fat shard; starting it a metre out keeps it thin.
    const start = Math.min(0.9, fullLength * 0.5);
    const length = fullLength - start;
    entry.mesh.position.copy(from).addScaledVector(tmp, start + length / 2);
    entry.mesh.scale.set(1, 1, length);
    entry.mesh.lookAt(to);
    entry.mesh.visible = true;
    entry.life = TRACER_LIFE;
  }

  function throwGrenade(from, direction, speed = 13) {
    for (const g of grenades) {
      if (g.active) continue;
      g.active = true;
      g.mesh.visible = true;
      g.mesh.position.copy(from);
      g.velocity.copy(direction).multiplyScalar(speed);
      g.velocity.y += 3.2;
      g.fuse = GRENADE_FUSE;
      return true;
    }
    return false;
  }

  // Returns a list of {position, radius} explosions that happened this step,
  // written into the caller-provided array so nothing is allocated here.
  function step(dt, explosions) {
    for (const t of tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const g of grenades) {
      if (!g.active) continue;
      g.fuse -= dt;
      g.velocity.y -= GRAVITY * dt;
      const p = g.mesh.position;
      const nextX = p.x + g.velocity.x * dt;
      const nextZ = p.z + g.velocity.z * dt;
      const nextY = p.y + g.velocity.y * dt;
      probe.min.set(Math.min(p.x, nextX) - 0.09, Math.min(p.y, nextY) - 0.09, Math.min(p.z, nextZ) - 0.09);
      probe.max.set(Math.max(p.x, nextX) + 0.09, Math.max(p.y, nextY) + 0.09, Math.max(p.z, nextZ) + 0.09);
      let blocked = nextY < 0.09;
      for (let i = 0; !blocked && i < colliders.length; i += 1) {
        if (probe.intersectsBox(colliders[i])) blocked = true;
      }
      if (blocked) {
        // Simple bounce: kill the component that hit, damp the rest.
        if (nextY < 0.09) { g.velocity.y = Math.abs(g.velocity.y) * 0.35; p.y = 0.09; }
        else { g.velocity.x *= -0.4; g.velocity.z *= -0.4; g.velocity.y *= 0.5; }
      } else {
        p.set(nextX, nextY, nextZ);
      }
      if (g.fuse <= 0) {
        g.active = false;
        g.mesh.visible = false;
        blast.position.copy(p);
        blast.visible = true;
        blastLife = 0.45;
        blastRadius = GRENADE_RADIUS;
        blastLight.position.copy(p);
        blastLight.intensity = 60;
        explosions.push({ position: p, radius: GRENADE_RADIUS, damage: GRENADE_DAMAGE });
      }
    }
    if (blastLife > 0) {
      blastLife -= dt;
      const k = 1 - blastLife / 0.45;
      const r = 0.5 + k * blastRadius;
      blast.scale.set(r, r, r);
      blast.material.opacity = Math.max(0, 0.85 * (1 - k));
      blastLight.intensity = Math.max(0, 60 * (1 - k));
      if (blastLife <= 0) {
        blast.visible = false;
        blastLight.intensity = 0;
      }
    }
  }

  function reset() {
    for (const t of tracers) { t.life = 0; t.mesh.visible = false; }
    for (const g of grenades) { g.active = false; g.mesh.visible = false; }
    blastLife = 0;
    blast.visible = false;
    blastLight.intensity = 0;
  }

  return { addTracer, throwGrenade, step, reset };
}
