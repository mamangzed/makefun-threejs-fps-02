// Foundry Nine: the map. One arena, three lanes, two bomb sites.
// Vanguard spawns south (z +), Ember spawns north (z -). A site is west, B site east.
// Every box is both a collider and a surface a bullet stops on; the waypoint graph
// (nodes + edges) is what the bots navigate. Straight lines between adjacent nodes
// are kept clear of cover on purpose.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const HALF_X = 20;
const HALF_Z = 18;
const WALL_H = 5;

export const SITES = {
  A: { minX: -19, maxX: -11, minZ: -17, maxZ: -5, center: [-15, -11] },
  B: { minX: 11, maxX: 19, minZ: -17, maxZ: -5, center: [15, -11] },
};

export const SPAWNS = {
  vanguard: [[-4, 15], [0, 15.5], [4, 15]],
  ember: [[-6, -15], [0, -15.5], [6, -15], [-2, -14]],
};

// Waypoint nodes [x, z]; edges are index pairs. Bots walk node to node.
export const WAYPOINTS = {
  nodes: [
    [0, 15], [-4, 15], [4, 15], [0, 8], [0, 1], [0, -6],
    [-8, 9], [-14, 2], [-15, -11], [8, 9], [14, 2], [15, -11],
    [0, -14], [-6, -14], [6, -14], [-8, -4], [8, -4],
    [-14, -14], [14, -14], [-9, 13], [9, 13],
  ],
  edges: [
    [0, 3], [1, 6], [2, 9], [1, 0], [2, 0], [3, 4],
    [4, 5], [4, 7], [4, 10], [5, 15], [5, 16], [5, 12], [6, 7], [7, 8],
    [7, 15], [8, 17], [9, 10], [10, 11], [10, 16], [11, 18], [12, 13],
    [12, 14], [12, 5], [13, 15], [13, 17], [14, 16], [14, 18], [15, 17],
    [16, 18], [6, 19], [9, 20], [19, 0], [20, 0],
  ],
};

export function createMap(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const mat = {};
  for (const name of ['canvas', 'surface', 'steel', 'floor', 'ink', 'muted']) {
    mat[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'floor' ? 0.95 : 0.88,
      metalness: name === 'steel' ? 0.35 : 0.04,
    });
  }
  const accentMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.1,
    emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 0.55,
  });
  const siteMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.site), roughness: 0.8, metalness: 0.05,
    emissive: new THREE.Color(PALETTE.site), emissiveIntensity: 0.25,
  });
  const vanguardMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.vanguard), roughness: 0.6, metalness: 0.1,
    emissive: new THREE.Color(PALETTE.vanguard), emissiveIntensity: 0.35,
  });
  const emberMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.ember), roughness: 0.6, metalness: 0.1,
    emissive: new THREE.Color(PALETTE.ember), emissiveIntensity: 0.35,
  });

  const colliders = [];
  const shootables = [];

  function box(w, h, d, x, y, z, material, collide = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }

  // Floor and the four outer walls.
  box(HALF_X * 2 + 0.8, 0.4, HALF_Z * 2 + 0.8, 0, -0.2, 0, mat.floor);
  box(0.4, WALL_H, HALF_Z * 2 + 0.8, -HALF_X - 0.2, WALL_H / 2, 0, mat.surface);
  box(0.4, WALL_H, HALF_Z * 2 + 0.8, HALF_X + 0.2, WALL_H / 2, 0, mat.surface);
  box(HALF_X * 2 + 0.8, WALL_H, 0.4, 0, WALL_H / 2, -HALF_Z - 0.2, mat.surface);
  box(HALF_X * 2 + 0.8, WALL_H, 0.4, 0, WALL_H / 2, HALF_Z + 0.2, mat.surface);

  // Lane dividers: low walls that split the arena into left / mid / right lanes
  // without closing any sightline outright.
  box(0.5, 2.2, 7, -7, 1.1, 6, mat.steel);
  box(0.5, 2.2, 7, 7, 1.1, 6, mat.steel);
  box(0.5, 2.2, 6, -7, 1.1, -8, mat.steel);
  box(0.5, 2.2, 6, 7, 1.1, -8, mat.steel);
  // North wall segments with a mid gap: the last cover before each site.
  box(4, 2.4, 0.5, -4, 1.2, -9, mat.steel);
  box(4, 2.4, 0.5, 4, 1.2, -9, mat.steel);

  // Pillars in the middle of the arena.
  box(1.2, 3.6, 1.2, -10, 1.8, 0, mat.steel);
  box(1.2, 3.6, 1.2, 10, 1.8, 0, mat.steel);
  box(1.2, 3.6, 1.2, 0, 1.8, -13.5, mat.steel);

  // Crates: crouch cover, placed off the waypoint lines.
  box(1.4, 1.1, 1.4, -3.2, 0.55, 6, mat.steel);
  box(1.4, 1.1, 1.4, 3.2, 0.55, -3, mat.steel);
  box(1.4, 1.1, 1.4, -12, 0.55, -6, mat.steel);
  box(1.4, 1.1, 1.4, 12, 0.55, -6, mat.steel);
  box(1.6, 1.1, 1.6, -16, 0.55, -13, mat.steel);
  box(1.6, 1.1, 1.6, 16, 0.55, -13, mat.steel);
  box(1.4, 1.1, 1.4, -13, 0.55, -8.5, mat.steel);
  box(1.4, 1.1, 1.4, 13, 0.55, -8.5, mat.steel);
  box(1.4, 1.1, 1.4, -6, 0.55, 12, mat.steel);
  box(1.4, 1.1, 1.4, 6, 0.55, 12, mat.steel);
  // Two stacked crates make a tall corner on each site.
  box(1.4, 1.1, 1.4, -18, 0.55, -8, mat.steel);
  box(1.1, 0.9, 1.1, -18, 1.55, -8, mat.steel);
  box(1.4, 1.1, 1.4, 18, 0.55, -8, mat.steel);
  box(1.1, 0.9, 1.1, 18, 1.55, -8, mat.steel);

  // Furnaces in the north corners: tall boxes with a glowing ember slit.
  box(3, 4.2, 2, -18, 2.1, -16, mat.surface);
  box(3, 4.2, 2, 18, 2.1, -16, mat.surface);
  box(2.4, 0.5, 0.1, -18, 1.4, -14.95, accentMat, false);
  box(2.4, 0.5, 0.1, 18, 1.4, -14.95, accentMat, false);

  // Bomb-site floor decals: painted ground the player must stand on to plant.
  for (const site of Object.values(SITES)) {
    const w = site.maxX - site.minX;
    const d = site.maxZ - site.minZ;
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(w, d), siteMat);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set((site.minX + site.maxX) / 2, 0.02, (site.minZ + site.maxZ) / 2);
    decal.receiveShadow = true;
    group.add(decal);
    // A site pylon so the site reads from across the map.
    const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.6, 0.5), siteMat);
    pylon.position.set(site.center[0], 1.3, site.center[1]);
    pylon.castShadow = true;
    group.add(pylon);
  }

  // Team-coloured trim along the spawn walls, so each half of the map reads at a glance.
  box(8, 0.3, 0.1, 0, 2.6, HALF_Z - 0.05, vanguardMat, false);
  box(8, 0.3, 0.1, 0, 2.6, -HALF_Z + 0.05, emberMat, false);

  // Lighting: warm key low from the furnaces' side, cool fill from above, sky gradient.
  const sky = new THREE.HemisphereLight(new THREE.Color(PALETTE.ink), new THREE.Color(PALETTE.canvas), 1.5);
  scene.add(sky);

  const key = new THREE.DirectionalLight(new THREE.Color(0xffe0b8), 2.6);
  key.position.set(10, 16, 8);
  key.target.position.set(0, 0, -4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -24;
  key.shadow.camera.right = 24;
  key.shadow.camera.top = 24;
  key.shadow.camera.bottom = -24;
  key.shadow.camera.far = 60;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.7);
  fill.position.set(-9, 10, 12);
  scene.add(fill);

  // Furnace glow: two warm point lights in the north corners.
  const glowA = new THREE.PointLight(new THREE.Color(PALETTE.accent), 26, 16);
  glowA.position.set(-18, 2.2, -14.5);
  scene.add(glowA);
  const glowB = new THREE.PointLight(new THREE.Color(PALETTE.accent), 26, 16);
  glowB.position.set(18, 2.2, -14.5);
  scene.add(glowB);

  return { colliders, shootables, group };
}
