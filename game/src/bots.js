// Bots: one body, one brain. Vanguard bots attack the sites with the player;
// Ember bots hold the sites and converge to defuse once the bomb is down.
// A bot's brain is a small state machine: route -> hold -> engage -> plant/defuse.
// Perception is staggered (each bot re-checks line of sight a few times a second),
// reaction takes a beat after first sight, and fire comes in bursts with pauses,
// so a bot reads as a person, not an aimbot.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createMover } from './mover.js';
import { WAYPOINTS, SITES } from './map.js';
import { range, chance } from './rng.js';

const BOT_SPEED = 4.2;
const BOT_ACCEL = 30;
const BOT_FRICTION = 8;
const SEE_RANGE = 45;
const REACT_MIN = 0.35;
const REACT_MAX = 0.75;
const BURST_MIN = 3;
const BURST_MAX = 5;
const BURST_GAP = 0.115;
const BURST_PAUSE_MIN = 0.5;
const BURST_PAUSE_MAX = 0.9;
const PLANT_TIME = 3;
const DEFUSE_TIME = 5;
const HEALTH = 100;

const VANGUARD_NAMES = ['VEX', 'MARA'];
const EMBER_NAMES = ['ASH', 'CINDER', 'SLAG', 'RUST'];

// Breadth-first route over the waypoint graph, from the node nearest `from`
// to `targetNode`. Returns an array of node indices, start excluded.
function findRoute(adjacency, from, targetNode) {
  if (from === targetNode) return [];
  const prev = new Array(adjacency.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === targetNode) break;
    for (const next of adjacency[node]) {
      if (prev[next] === -1) {
        prev[next] = node;
        queue.push(next);
      }
    }
  }
  if (prev[targetNode] === -1) return [];
  const path = [];
  let node = targetNode;
  while (node !== from) {
    path.unshift(node);
    node = prev[node];
  }
  return path;
}

function nearestNode(x, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WAYPOINTS.nodes.length; i += 1) {
    const [nx, nz] = WAYPOINTS.nodes[i];
    const d = (nx - x) * (nx - x) + (nz - z) * (nz - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function siteNode(siteKey) {
  return siteKey === 'A' ? 8 : 11;
}

function createBotMesh(scene, team) {
  const teamColor = team === 'vanguard' ? PALETTE.vanguard : PALETTE.ember;
  const torsoMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.6, metalness: 0.1 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.canvas), roughness: 0.7, metalness: 0.2 });
  const headMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.55, metalness: 0.05 });

  const group = new THREE.Group();
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.28), darkMat);
  legs.position.y = 0.31;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), torsoMat);
  torso.position.y = 1.0;
  torso.userData.part = 'torso';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), headMat);
  head.position.y = 1.53;
  head.userData.part = 'head';
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: new THREE.Color(teamColor) }));
  visor.position.set(0, 1.55, -0.14);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.55), darkMat);
  gun.position.set(0.2, 1.15, -0.3);
  const muzzle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  muzzle.position.set(0.2, 1.15, -0.62);
  muzzle.visible = false;
  group.add(legs, torso, head, visor, gun, muzzle);
  group.traverse((mesh) => {
    if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true; }
  });
  scene.add(group);
  return { group, torso, head, muzzle };
}

export function createBots(scene, colliders) {
  const adjacency = WAYPOINTS.nodes.map(() => []);
  for (const [a, b] of WAYPOINTS.edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  const bots = [];
  const tmp = new THREE.Vector3();

  function makeBot(team, name, index) {
    const mesh = createBotMesh(scene, team);
    const mover = createMover(colliders, 0, 0);
    const bot = {
      team, name, index,
      mover, mesh,
      health: HEALTH, alive: true, fall: 0,
      state: 'route',
      route: [], routeCursor: 0, routeTarget: -1,
      targetSite: 'A',
      holdNode: -1,
      visibleEnemy: null,
      lastSeenAt: -99,
      reactionAt: 0,
      burstLeft: 0,
      burstTimer: 0,
      pauseTimer: 0,
      strafeDir: 1,
      strafeTimer: 0,
      scanYaw: 0,
      channel: 0,
      channelKind: null,
      perceiveTimer: index * 0.05,
      muzzleTimer: 0,
    };
    mesh.torso.userData.bot = bot;
    mesh.head.userData.bot = bot;
    bots.push(bot);
    return bot;
  }

  const vanguard = [makeBot('vanguard', VANGUARD_NAMES[0], 0), makeBot('vanguard', VANGUARD_NAMES[1], 1)];
  const ember = EMBER_NAMES.map((name, i) => makeBot('ember', name, 2 + i));

  function routeTo(bot, targetNode) {
    const from = nearestNode(bot.mover.body.position.x, bot.mover.body.position.z);
    bot.route = findRoute(adjacency, from, targetNode);
    bot.routeCursor = 0;
    bot.routeTarget = targetNode;
    bot.state = 'route';
  }

  function reset(roundRandom, assignments) {
    // assignments: { vanguardSite, emberHolds: [node, node, node, node] }
    for (const bot of bots) {
      bot.health = HEALTH;
      bot.alive = true;
      bot.fall = 0;
      bot.visibleEnemy = null;
      bot.channel = 0;
      bot.channelKind = null;
      bot.mesh.group.rotation.set(0, 0, 0);
      bot.mesh.group.position.y = 0;
      bot.mesh.muzzle.visible = false;
    }
    const vSpawns = [[-4, 15], [4, 15]];
    const eSpawns = [[-6, -15], [0, -15.5], [6, -15], [-2, -14]];
    vanguard.forEach((bot, i) => {
      bot.targetSite = assignments.vanguardSite;
      bot.mover.teleport(vSpawns[i][0], vSpawns[i][1], Math.PI);
      routeTo(bot, siteNode(assignments.vanguardSite));
    });
    ember.forEach((bot, i) => {
      bot.targetSite = assignments.vanguardSite;
      bot.holdNode = assignments.emberHolds[i];
      bot.mover.teleport(eSpawns[i][0], eSpawns[i][1], 0);
      routeTo(bot, assignments.emberHolds[i]);
    });
  }

  function damage(bot, amount) {
    if (!bot.alive) return false;
    bot.health -= amount;
    if (bot.health > 0) return false;
    bot.alive = false;
    bot.fall = 0;
    bot.channel = 0;
    bot.channelKind = null;
    return true;
  }

  // Step one bot. `world` is the shared game state the main loop owns:
  // { now, time, los(from, to), findEnemy(bot), fire(bot, targetPos),
  //   bomb: { state, site }, playerAlive, onPlant(bot), onDefuse(bot) }
  function stepBot(bot, dt, world, random) {
    if (!bot.alive) {
      bot.fall = Math.min(1, bot.fall + dt / 0.4);
      bot.mesh.group.rotation.x = -bot.fall * 1.45;
      bot.mesh.group.position.y = -bot.fall * 0.08;
      return;
    }
    const body = bot.mover.body;
    bot.muzzleTimer = Math.max(0, bot.muzzleTimer - dt);
    bot.mesh.muzzle.visible = bot.muzzleTimer > 0;

    // Perception, staggered per bot.
    bot.perceiveTimer -= dt;
    if (bot.perceiveTimer <= 0) {
      bot.perceiveTimer = 0.12;
      const enemy = world.findEnemy(bot);
      if (enemy) {
        if (!bot.visibleEnemy) bot.reactionAt = world.now + range(random, REACT_MIN, REACT_MAX);
        bot.visibleEnemy = enemy;
        bot.lastSeenAt = world.now;
      } else if (bot.visibleEnemy && world.now - bot.lastSeenAt > 2) {
        bot.visibleEnemy = null;
      }
    }

    // Bomb logic overrides routing.
    const bomb = world.bomb;
    if (bomb.state === 'planted' && bot.team === 'ember' && bot.state !== 'defuse') {
      const site = SITES[bomb.site];
      const dx = site.center[0] - body.position.x;
      const dz = site.center[1] - body.position.z;
      if (Math.hypot(dx, dz) < 1.6) {
        bot.state = 'defuse';
        bot.channel = 0;
        bot.channelKind = 'defuse';
      } else if (bot.routeTarget !== siteNode(bomb.site)) {
        routeTo(bot, siteNode(bomb.site));
      }
    }
    if (bomb.state === 'carried' && bot.team === 'vanguard' && !world.playerAlive && bot.state !== 'plant') {
      // Player is down: a teammate takes the bomb to the site.
      const site = SITES[bot.targetSite];
      const dx = site.center[0] - body.position.x;
      const dz = site.center[1] - body.position.z;
      if (Math.hypot(dx, dz) < 1.6 && !bot.visibleEnemy) {
        bot.state = 'plant';
        bot.channel = 0;
        bot.channelKind = 'plant';
      } else if (bot.routeTarget !== siteNode(bot.targetSite)) {
        routeTo(bot, siteNode(bot.targetSite));
      }
    }

    let wishX = 0;
    let wishZ = 0;
    let speed = BOT_SPEED;

    if (bot.state === 'plant' || bot.state === 'defuse') {
      // Channel: stand still. Damage interrupts (handled by damage() clearing channel).
      const needed = bot.channelKind === 'plant' ? PLANT_TIME : DEFUSE_TIME;
      bot.channel += dt;
      if (bot.channelKind === 'plant' && world.now % 1 < dt) world.beep('plant');
      if (bot.channelKind === 'defuse' && world.now % 1 < dt) world.beep('defuse');
      if (bot.channel >= needed) {
        const kind = bot.channelKind;
        bot.channel = 0;
        bot.channelKind = null;
        bot.state = 'hold';
        if (kind === 'plant') world.onPlant(bot);
        else world.onDefuse(bot);
      }
      // Face the site centre while channelling.
      const site = SITES[bot.targetSite];
      body.yaw = Math.atan2(-(site.center[0] - body.position.x), -(site.center[1] - body.position.z));
    } else if (bot.visibleEnemy) {
      // Engage: face the enemy, strafe, fire in bursts after the reaction beat.
      const e = bot.visibleEnemy;
      const ex = e.position.x;
      const ey = e.position.y + e.eye * 0.8;
      const ez = e.position.z;
      const dx = ex - body.position.x;
      const dy = ey - (body.position.y + body.eye);
      const dz = ez - body.position.z;
      const dist = Math.hypot(dx, dy, dz) || 1;
      body.yaw = Math.atan2(-dx, -dz);
      body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / dist)));
      bot.strafeTimer -= dt;
      if (bot.strafeTimer <= 0) {
        bot.strafeTimer = range(random, 0.7, 1.4);
        bot.strafeDir = chance(random, 0.5) ? 1 : -1;
      }
      const sideX = Math.cos(body.yaw) * bot.strafeDir;
      const sideZ = -Math.sin(body.yaw) * bot.strafeDir;
      wishX = sideX;
      wishZ = sideZ;
      speed = BOT_SPEED * 0.55;
      if (world.now >= bot.reactionAt && dist < SEE_RANGE) {
        if (bot.burstLeft > 0) {
          bot.burstTimer -= dt;
          if (bot.burstTimer <= 0) {
            bot.burstTimer = BURST_GAP;
            bot.burstLeft -= 1;
            tmp.set(ex, ey, ez);
            world.fire(bot, tmp, dist);
            bot.muzzleTimer = 0.06;
          }
        } else {
          bot.pauseTimer -= dt;
          if (bot.pauseTimer <= 0) {
            bot.burstLeft = Math.floor(range(random, BURST_MIN, BURST_MAX + 1));
            bot.pauseTimer = range(random, BURST_PAUSE_MIN, BURST_PAUSE_MAX);
          }
        }
      }
    } else if (bot.state === 'route') {
      if (bot.routeCursor >= bot.route.length) {
        bot.state = 'hold';
        bot.scanYaw = body.yaw;
      } else {
        const [tx, tz] = WAYPOINTS.nodes[bot.route[bot.routeCursor]];
        const dx = tx - body.position.x;
        const dz = tz - body.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.7) {
          bot.routeCursor += 1;
        } else {
          wishX = dx / dist;
          wishZ = dz / dist;
          body.yaw = Math.atan2(-dx, -dz);
          body.pitch = 0;
        }
      }
    } else if (bot.state === 'hold') {
      // Scan: slow yaw sweep, watching the lane.
      bot.scanYaw += dt * 0.5;
      body.yaw = bot.scanYaw + Math.sin(world.now * 0.4 + bot.index) * 0.7;
      body.pitch = 0;
    }

    const groundSpeed = bot.mover.step(dt, wishX, wishZ, speed, BOT_ACCEL, BOT_FRICTION, false, false);
    void groundSpeed;
    bot.mesh.group.position.set(body.position.x, body.position.y, body.position.z);
    bot.mesh.group.rotation.y = body.yaw;
  }

  function step(dt, world, random) {
    for (const bot of bots) stepBot(bot, dt, world, random);
  }

  function aliveCount(team) {
    return bots.filter((b) => b.team === team && b.alive).length;
  }

  function hearShot(position, rangeMeters, world) {
    // Defenders near a gunshot investigate: reroute to the nearest node.
    for (const bot of bots) {
      if (!bot.alive || bot.visibleEnemy || bot.state === 'plant' || bot.state === 'defuse') continue;
      const dx = position.x - bot.mover.body.position.x;
      const dz = position.z - bot.mover.body.position.z;
      if (Math.hypot(dx, dz) > rangeMeters) continue;
      if (bot.team === 'ember' && world.bomb.state !== 'planted') {
        routeTo(bot, nearestNode(position.x, position.z));
      }
    }
  }

  return {
    bots, vanguard, ember,
    reset, step, damage, aliveCount, hearShot, nearestNode,
    hitMeshes() {
      const meshes = [];
      for (const bot of bots) {
        meshes.push(bot.mesh.torso, bot.mesh.head);
      }
      return meshes;
    },
  };
}
