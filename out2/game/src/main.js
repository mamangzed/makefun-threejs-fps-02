// Foundry Nine — boot and the one loop: a fixed 60 Hz simulation feeding a render
// at the display's rate. One state store lives here: the player, the round, the
// bots and the effects all read it, and the HUD is pushed from it every frame.
// ?shot=start|play|buy|end with &seed=N stages a deterministic frame for a
// capture, renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32 } from './rng.js';
import { createMap, SITES, SPAWNS } from './map.js';
import { createMover } from './mover.js';
import { createGun, WEAPONS, ARMOR_REDUCTION } from './weapons.js';
import { createBots } from './bots.js';
import { createRound, ROUND_TIME } from './round.js';
import { createFx } from './fx.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';

const FIXED_STEP = 1 / 60;
const SEE_RANGE = 45;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

const simRandom = mulberry32(seed * 7919 + 13);
let roundRandom = mulberry32(seed * 7919 + 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 26, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createMap(scene);
const bots = createBots(scene, world.colliders);
const fx = createFx(scene, world.colliders);
const audio = createAudio();
const hud = createHud();
const round = createRound();
const gun = createGun(camera, 'pistol');
const playerMover = createMover(world.colliders, 0, 15.5);
const player = playerMover.body;

// Invisible hit meshes for the player, so bot fire can raycast the player the
// same way player fire raycasts bots. The material is invisible; raycast still hits.
const playerHitGroup = new THREE.Group();
const invisibleMat = new THREE.MeshBasicMaterial({ visible: false });
const playerTorso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.78, 0.3), invisibleMat);
playerTorso.position.y = 1.0;
playerTorso.userData.part = 'torso';
playerTorso.userData.isPlayer = true;
const playerHead = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), invisibleMat);
playerHead.position.y = 1.53;
playerHead.userData.part = 'head';
playerHead.userData.isPlayer = true;
playerHitGroup.add(playerTorso, playerHead);
scene.add(playerHitGroup);

const input = createInput(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
const losRay = new THREE.Raycaster();
const shootables = world.shootables.concat(bots.hitMeshes(), playerTorso, playerHead);

const direction = new THREE.Vector3();
const muzzlePoint = new THREE.Vector3();
const targetPoint = new THREE.Vector3();
const eyePoint = new THREE.Vector3();
const chestPoint = new THREE.Vector3();

const state = {
  health: 100,
  armor: 0,
  alive: true,
  grenades: 0,
  owned: ['pistol'],
  planting: 0,
  plantSite: null,
  buyOpen: false,
  started: false,
  spectate: null,
};

let now = 0;
let elapsed = 0;
let frozen = false;
let accumulator = 0;
let lastTime = performance.now();
let prevPhase = round.state.phase;
let prevFiring = false;
const explosions = [];

function siteAt(x, z) {
  for (const [key, site] of Object.entries(SITES)) {
    if (x >= site.minX && x <= site.maxX && z >= site.minZ && z <= site.maxZ) return key;
  }
  return null;
}

function syncCamera() {
  if (state.spectate) {
    const bot = state.spectate;
    const b = bot.mover.body;
    camera.position.set(b.position.x, b.position.y + b.eye, b.position.z);
    camera.rotation.set(b.pitch, b.yaw, 0, 'YXZ');
    return;
  }
  camera.position.set(player.position.x, player.position.y + player.eye, player.position.z);
  camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  playerHitGroup.position.set(player.position.x, player.position.y, player.position.z);
  playerHitGroup.rotation.y = player.yaw;
}

function aimAt(point) {
  const dx = point.x - player.position.x;
  const dy = point.y - (player.position.y + player.eye);
  const dz = point.z - player.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

function losClear(from, to) {
  targetPoint.subVectors(to, from);
  const dist = targetPoint.length();
  if (dist < 0.01) return true;
  targetPoint.multiplyScalar(1 / dist);
  losRay.set(from, targetPoint);
  losRay.far = dist;
  const hit = losRay.intersectObjects(world.shootables, false)[0];
  return !hit || hit.distance > dist - 0.4;
}

// Nearest enemy this bot can actually see: player or an enemy bot, in range,
// with a clear line to the chest.
function findEnemy(bot) {
  const b = bot.mover.body;
  eyePoint.set(b.position.x, b.position.y + b.eye, b.position.z);
  let best = null;
  let bestDist = SEE_RANGE;
  const candidates = [];
  if (state.alive && bot.team === 'ember') {
    candidates.push({ position: player.position, eye: player.eye, isPlayer: true, ref: null });
  }
  for (const other of bots.bots) {
    if (other.team === bot.team || !other.alive) continue;
    candidates.push({ position: other.mover.body.position, eye: other.mover.body.eye, isPlayer: false, ref: other });
  }
  for (const c of candidates) {
    chestPoint.set(c.position.x, c.position.y + 1.0, c.position.z);
    const dist = eyePoint.distanceTo(chestPoint);
    if (dist > bestDist) continue;
    if (!losClear(eyePoint, chestPoint)) continue;
    bestDist = dist;
    best = c;
  }
  return best;
}

// One hitscan shot from a bot at a point it is aiming at.
function botFire(bot, aim, dist) {
  const b = bot.mover.body;
  const def = WEAPONS.rifle;
  eyePoint.set(b.position.x, b.position.y + b.eye, b.position.z);
  direction.subVectors(aim, eyePoint).normalize();
  // Bots are dangerous up close and wild at range: spread grows with distance,
  // and damage falls off, so a cross-map spray rarely kills.
  const spread = 0.006 + Math.min(1, bot.mover.groundSpeed() / 5.2) * 0.022 + dist * 0.0012;
  const falloff = Math.max(0.4, 1 - dist / 80);
  direction.x += (simRandom() * 2 - 1) * spread;
  direction.y += (simRandom() * 2 - 1) * spread;
  direction.z += (simRandom() * 2 - 1) * spread;
  direction.normalize();
  raycaster.set(eyePoint, direction);
  raycaster.far = def.range;
  const hit = raycaster.intersectObjects(shootables, false)[0];
  muzzlePoint.set(b.position.x, b.position.y + b.eye - 0.1, b.position.z);
  muzzlePoint.addScaledVector(direction, 0.6);
  if (hit) {
    fx.addTracer(muzzlePoint, hit.point);
    if (hit.object.userData.isPlayer) {
      damagePlayer(Math.round((hit.object.userData.part === 'head' ? def.headDamage : def.damage) * falloff), bot);
    } else if (hit.object.userData.bot && hit.object.userData.bot.team !== bot.team) {
      const victim = hit.object.userData.bot;
      const killed = bots.damage(victim, Math.round((hit.object.userData.part === 'head' ? def.headDamage : def.damage) * falloff));
      if (killed) hud.killfeedLine(`${bot.name} eliminated ${victim.name}`, false);
    }
  } else {
    targetPoint.copy(eyePoint).addScaledVector(direction, def.range);
    fx.addTracer(muzzlePoint, targetPoint);
  }
  const playerDist = eyePoint.distanceTo(player.position);
  audio.enemyShot(playerDist);
}

function damagePlayer(amount, attacker) {
  if (!state.alive) return;
  let remaining = amount;
  if (state.armor > 0) {
    const absorbed = Math.min(state.armor, remaining * ARMOR_REDUCTION);
    state.armor -= absorbed;
    remaining -= absorbed;
  }
  state.health -= remaining;
  audio.hurt();
  if (state.health <= 0) {
    state.health = 0;
    state.alive = false;
    round.state.deaths += 1;
    hud.killfeedLine(attacker ? `${attacker.name} eliminated YOU` : 'You were eliminated', false);
    hud.showBanner('You are down — your team fights on', 3000);
    state.spectate = bots.vanguard.find((b) => b.alive) ?? null;
    if (document.pointerLockElement) document.exitPointerLock();
    checkRoundEnd();
  }
}

function playerShoot(spread) {
  if (!gun.takeRound()) {
    audio.dryClick();
    return false;
  }
  camera.getWorldDirection(direction);
  direction.x += (simRandom() * 2 - 1) * spread;
  direction.y += (simRandom() * 2 - 1) * spread;
  direction.z += (simRandom() * 2 - 1) * spread;
  direction.normalize();
  scene.updateMatrixWorld(true);
  raycaster.set(camera.position, direction);
  raycaster.far = gun.def.range;
  const hit = raycaster.intersectObjects(shootables, false)[0];
  muzzlePoint.copy(camera.position).addScaledVector(direction, 0.6);
  muzzlePoint.x += Math.cos(player.yaw) * 0.24;
  muzzlePoint.y -= 0.18;
  if (hit) {
    fx.addTracer(muzzlePoint, hit.point);
    const victim = hit.object.userData.bot;
    if (victim && victim.team === 'ember' && victim.alive) {
      const isHead = hit.object.userData.part === 'head';
      const killed = bots.damage(victim, isHead ? gun.def.headDamage : gun.def.damage);
      hud.hitMarker(killed, killed ? 300 : 90);
      if (killed) {
        audio.kill();
        round.state.money += 300;
        round.state.kills += 1;
        hud.killfeedLine(`YOU eliminated ${victim.name}${isHead ? ' — headshot' : ''}`, true);
        hud.setMoney(round.state.money);
        checkRoundEnd();
      } else {
        audio.hit();
      }
    }
  } else {
    targetPoint.copy(camera.position).addScaledVector(direction, gun.def.range);
    fx.addTracer(muzzlePoint, targetPoint);
  }
  gun.pullTrigger();
  playerMover.body.pitch = Math.min(1.45, player.pitch + gun.def.recoil * (0.8 + simRandom() * 0.4));
  player.yaw += (simRandom() * 2 - 1) * gun.def.recoil * 0.4;
  audio.shot();
  bots.hearShot(camera.position, 26, worldCtx);
  hud.setAmmo(gun.state.mag, gun.state.reserve);
  return true;
}

function throwGrenade() {
  if (state.grenades <= 0 || round.state.phase !== 'live') return;
  camera.getWorldDirection(direction);
  eyePoint.copy(camera.position).addScaledVector(direction, 0.5);
  if (fx.throwGrenade(eyePoint, direction, 13)) {
    state.grenades -= 1;
    hud.setGrenades(state.grenades);
    audio.shot();
  }
}

function applyExplosion(explosion) {
  const p = explosion.position;
  let anyHit = false;
  for (const bot of bots.bots) {
    if (!bot.alive) continue;
    const b = bot.mover.body;
    const dist = Math.hypot(b.position.x - p.x, (b.position.y + 1 - p.y), b.position.z - p.z);
    if (dist > explosion.radius) continue;
    const dmg = Math.round(explosion.damage * (1 - dist / (explosion.radius + 1)));
    const killed = bots.damage(bot, dmg);
    anyHit = true;
    if (killed && bot.team === 'ember') {
      round.state.money += 300;
      round.state.kills += 1;
      hud.killfeedLine(`YOU eliminated ${bot.name} — grenade`, true);
      hud.setMoney(round.state.money);
    }
  }
  if (state.alive) {
    const dist = Math.hypot(player.position.x - p.x, (player.position.y + 1 - p.y), player.position.z - p.z);
    if (dist <= explosion.radius) {
      damagePlayer(Math.round(explosion.damage * (1 - dist / (explosion.radius + 1))), null);
      anyHit = true;
    }
  }
  if (anyHit) audio.explosion();
  else if (p.distanceTo(player.position) < 30) audio.explosion();
  checkRoundEnd();
}

function checkRoundEnd() {
  if (round.state.phase !== 'live') return;
  const emberAlive = bots.aliveCount('ember');
  const vanguardAlive = bots.aliveCount('vanguard') + (state.alive ? 1 : 0);
  if (emberAlive === 0) {
    endRoundNow('vanguard', 'Ember team eliminated');
  } else if (vanguardAlive === 0 && round.state.bomb.state !== 'planted') {
    endRoundNow('ember', 'Vanguard team eliminated');
  }
}

function endRoundNow(winner, reason) {
  if (!round.endRound(winner, reason)) return;
  announceRoundEnd(winner);
}

function announceRoundEnd(winner) {
  hud.showBanner(winner === 'vanguard' ? `Round ${round.state.round} — Vanguard wins` : `Round ${round.state.round} — Ember wins`, 3200);
  if (winner === 'vanguard') audio.roundWin();
  else audio.roundLose();
  hud.setMoney(round.state.money);
  hud.setScore(round.state.score.vanguard, round.state.score.ember);
}

const worldCtx = {
  get now() { return now; },
  los: losClear,
  findEnemy,
  fire: botFire,
  get bomb() { return round.state.bomb; },
  get playerAlive() { return state.alive; },
  beep(kind) { if (kind === 'plant') audio.plantBeep(); else audio.defuseBeep(); },
  onPlant(bot) {
    round.plant(bot.targetSite);
    hud.killfeedLine(`${bot.name} planted the bomb on site ${bot.targetSite}`, false);
    hud.showBanner(`Bomb planted on site ${bot.targetSite} — defend it`, 3000);
    audio.plantBeep();
  },
  onDefuse(bot) {
    round.defuse();
    hud.killfeedLine(`${bot.name} defused the bomb`, false);
    announceRoundEnd('ember');
  },
};

function setupRound() {
  roundRandom = mulberry32(seed * 7919 + round.state.round * 131);
  const site = roundRandom() < 0.5 ? 'A' : 'B';
  const holds = [8, 15, 11, 5];
  // Shuffle the hold assignments deterministically.
  for (let i = holds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(roundRandom() * (i + 1));
    [holds[i], holds[j]] = [holds[j], holds[i]];
  }
  bots.reset(roundRandom, { vanguardSite: site, emberHolds: holds });
  fx.reset();
  playerMover.teleport(0, 15.5, 0);
  state.health = 100;
  state.alive = true;
  state.spectate = null;
  state.planting = 0;
  state.plantSite = null;
  gun.refill();
  hud.setHealth(state.health);
  hud.setArmor(state.armor);
  hud.setAmmo(gun.state.mag, gun.state.reserve);
  hud.setMoney(round.state.money);
  hud.setScore(round.state.score.vanguard, round.state.score.ember);
  hud.setRound(round.state.round);
  hud.setGrenades(state.grenades);
  hud.setBomb('Plant the bomb on site A or B');
  hud.showBanner(`Round ${round.state.round} — buy phase (B to shop)`, 2600);
}

function resetMatch() {
  round.reset();
  state.owned = ['pistol'];
  state.grenades = 0;
  state.armor = 0;
  gun.swap('pistol');
  hud.setWeapon('pistol');
  setupRound();
}

function step(dt) {
  now += dt;
  elapsed += dt;
  const phase = round.state.phase;

  // Phase transitions.
  if (phase !== prevPhase) {
    if (phase === 'buy') setupRound();
    if (phase === 'live') {
      hud.hideBuy();
      state.buyOpen = false;
      hud.showBanner('Go — plant the bomb or eliminate Ember', 1800);
    }
    if (phase === 'match') {
      hud.showOverlay('matchEnd', {
        winner: round.state.matchWinner,
        scoreV: round.state.score.vanguard,
        scoreE: round.state.score.ember,
      });
      if (document.pointerLockElement) document.exitPointerLock();
    }
    prevPhase = phase;
  }

  // Player movement and actions (frozen while the buy menu is open).
  const keys = input.state.keys;
  if (!state.buyOpen && state.alive) {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    let wishX = 0;
    let wishZ = 0;
    if (forward || strafe) {
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      const len = Math.hypot(forward, strafe);
      wishX = (-sin * forward + cos * strafe) / len;
      wishZ = (-cos * forward - sin * strafe) / len;
    }
    const crouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    const speed = player.crouching ? 2.4 : 5.2;
    playerMover.step(dt, wishX, wishZ, speed, 42, 9, keys.has('Space'), crouch);
  }
  gun.step(dt);

  // Bots move only while the round is live.
  if (phase === 'live') {
    bots.step(dt, worldCtx, roundRandom);
  }

  // Grenades and explosions.
  explosions.length = 0;
  fx.step(dt, explosions);
  for (const explosion of explosions) applyExplosion(explosion);

  // Planting: hold E inside a site while carrying the bomb.
  if (phase === 'live' && state.alive && keys.has('KeyE') && round.state.bomb.state === 'carried') {
    const site = siteAt(player.position.x, player.position.z);
    if (site) {
      if (state.plantSite !== site) {
        state.planting = 0;
        state.plantSite = site;
      }
      state.planting += dt / 3;
      if (Math.floor(now) !== Math.floor(now - dt)) audio.plantBeep();
      if (state.planting >= 1) {
        state.planting = 0;
        state.plantSite = null;
        round.plant(site);
        hud.killfeedLine(`YOU planted the bomb on site ${site}`, true);
        hud.showBanner(`Bomb planted on site ${site} — defend it`, 3000);
        audio.plantBeep();
      }
    } else {
      state.planting = 0;
      state.plantSite = null;
    }
  } else {
    state.planting = 0;
    state.plantSite = null;
  }

  round.step(dt);
  checkRoundEnd();

  // HUD push.
  hud.setHealth(state.health);
  hud.setArmor(state.armor);
  hud.setTimer(round.state.phaseTime, round.state.bomb.state === 'planted' ? round.state.bomb.timer : null);
  hud.setAlive(bots.aliveCount('vanguard') + (state.alive ? 1 : 0), bots.aliveCount('ember'));
  hud.setCrosshairGap(4 + gun.spread(playerMover.groundSpeed()) * 900);
  hud.setPlant(state.planting > 0 ? state.planting : null);
  if (round.state.bomb.state === 'planted') {
    hud.setBomb(`Bomb on site ${round.state.bomb.site} — ${Math.ceil(round.state.bomb.timer)}s`);
  } else if (round.state.bomb.state === 'carried') {
    hud.setBomb('Plant the bomb on site A or B');
  } else {
    hud.setBomb('');
  }
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dt = Math.min((nowMs - lastTime) / 1000, 0.1);
  lastTime = nowMs;
  if (!frozen) {
    const look = input.takeLook();
    if (state.alive && !state.buyOpen) {
      player.yaw -= look.x * 0.0022;
      player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - look.y * 0.0022));
    }
    // Firing: auto weapons hold, the pistol fires on the press.
    const firing = input.state.firing;
    const pressed = firing && !prevFiring;
    prevFiring = firing;
    if (state.alive && !state.buyOpen && round.state.phase === 'live') {
      if ((gun.def.auto && firing && gun.ready()) || (!gun.def.auto && pressed && gun.ready())) {
        playerShoot(gun.spread(playerMover.groundSpeed()));
      }
    }
    if (input.consumePressed('KeyR') && state.alive) {
      gun.reload();
      audio.reload();
    }
    if (input.consumePressed('KeyG')) throwGrenade();
    if (input.consumePressed('Digit1') && state.owned.includes('pistol')) { gun.swap('pistol'); hud.setWeapon('pistol'); hud.setAmmo(gun.state.mag, gun.state.reserve); }
    if (input.consumePressed('Digit2') && state.owned.includes('rifle')) { gun.swap('rifle'); hud.setWeapon('rifle'); hud.setAmmo(gun.state.mag, gun.state.reserve); }
    if (input.consumePressed('Digit3') && state.owned.includes('smg')) { gun.swap('smg'); hud.setWeapon('smg'); hud.setAmmo(gun.state.mag, gun.state.reserve); }
    if (input.consumePressed('KeyB') && round.state.phase === 'buy') toggleBuy();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function toggleBuy() {
  if (state.buyOpen) {
    state.buyOpen = false;
    hud.hideBuy();
    input.requestLock();
  } else {
    state.buyOpen = true;
    hud.showBuy(round.state.money, state.owned, round.state.round);
    input.releaseLock();
  }
}

hud.onBuy((id) => {
  if (round.state.phase !== 'buy') return;
  if (!round.buy(id)) return;
  audio.buy();
  if (id === 'rifle' || id === 'smg') {
    if (!state.owned.includes(id)) state.owned.push(id);
    gun.swap(id);
    hud.setWeapon(id);
    hud.setAmmo(gun.state.mag, gun.state.reserve);
  } else if (id === 'grenade') {
    state.grenades = Math.min(2, state.grenades + 1);
    hud.setGrenades(state.grenades);
  } else if (id === 'armor') {
    state.armor = 100;
    hud.setArmor(state.armor);
  }
  hud.setMoney(round.state.money);
  hud.refreshBuy(round.state.money, state.owned);
});

hud.onBuyClose(() => toggleBuy());

hud.onPlay(() => {
  audio.unlock();
  if (shot) return;
  if (round.state.phase === 'match') {
    resetMatch();
    hud.hideOverlay();
    input.requestLock();
    return;
  }
  input.requestLock();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    state.started = true;
    hud.hideOverlay();
  } else if (!state.buyOpen && round.state.phase !== 'match') {
    hud.showOverlay(state.started ? 'paused' : 'start');
  }
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

function runShot(name) {
  hud.hideOverlay();
  hud.hideBuy();
  resetMatch();
  if (name === 'start') {
    playerMover.teleport(0.6, 8.6, 0.35);
    player.pitch = 0.02;
    settle(20);
    aimAt(new THREE.Vector3(4, 1.5, -8));
    hud.showOverlay('start');
  } else if (name === 'play') {
    round.state.phase = 'live';
    round.state.phaseTime = ROUND_TIME;
    prevPhase = 'live';
    playerMover.teleport(3, 4, 0);
    const enemy = bots.ember[0];
    enemy.mover.teleport(4.5, -2, Math.PI);
    enemy.state = 'hold';
    const enemy2 = bots.ember[1];
    enemy2.mover.teleport(-2, -6, Math.PI * 0.75);
    enemy2.state = 'hold';
    settle(10);
    const chest = new THREE.Vector3(4.5, 1.0, -2);
    aimAt(chest);
    playerShoot(0);
    settle(2);
  } else if (name === 'buy') {
    playerMover.teleport(0, 15.5, 0);
    settle(10);
    hud.showBuy(3500, ['pistol', 'rifle'], round.state.round);
    state.buyOpen = true;
  } else if (name === 'end') {
    round.state.phase = 'live';
    prevPhase = 'live';
    playerMover.teleport(0, 4, 0);
    const fallenSpots = [[-3, -2], [2, -4], [-6, -8], [4, -9]];
    bots.ember.forEach((bot, i) => {
      bots.damage(bot, 999);
      bot.mover.teleport(fallenSpots[i][0], fallenSpots[i][1], 0);
    });
    settle(30);
    aimAt(new THREE.Vector3(-4, 1, -6));
    round.endRound('vanguard', 'Ember team eliminated');
    hud.showOverlay('roundEnd', {
      reason: 'Ember team eliminated',
      winner: 'vanguard',
      scoreV: round.state.score.vanguard,
      scoreE: round.state.score.ember,
    });
  }
  hud.setHealth(state.health);
  hud.setAmmo(gun.state.mag, gun.state.reserve);
  hud.setMoney(round.state.money);
  hud.setScore(round.state.score.vanguard, round.state.score.ember);
  hud.setRound(round.state.round);
  paintTwiceThenReady();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.setAmmo(gun.state.mag, gun.state.reserve);
hud.setMoney(round.state.money);
hud.setScore(0, 0);
hud.setRound(1);
hud.setAlive(3, 4);
syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
