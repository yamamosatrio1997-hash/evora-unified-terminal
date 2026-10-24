import './styles.css';
import { Agent } from './agents/Agent';
import { loadGltf, loadGltfAvatar } from './agents/GltfAvatar';
import { ProceduralAvatar } from './agents/ProceduralAvatar';
import { installBridge } from './bridge/EventBridge';
import { loadManifest, modelFor } from './config/assets';
import { LAYOUT, UPPER_SLAB } from './config/layout';
import { LEADS, ODIN, ROSTER, TRADERS, YAMA } from './config/roster';
import { NavGraph } from './core/NavGraph';
import { OfficeClock, type ClockMode } from './core/OfficeClock';
import { SimTime } from './core/SimTime';
import { SpotRegistry } from './core/Spots';
import { World } from './core/World';
import { buildOffice } from './scene/OfficeBuilder';
import { Screens } from './scene/Screens';
import { Director } from './sim/Director';
import { FundState } from './sim/FundState';
import type { Sim } from './sim/scenarios';
import { BubbleLayer } from './ui/Bubbles';
import { Hud } from './ui/Hud';

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const app = document.getElementById('app')!;
  const hudRoot = document.getElementById('hud')!;

  const world = new World(app);
  const fund = new FundState();
  const screens = new Screens(fund);
  const seatNames = Object.fromEntries(ROSTER.map((d) => [d.home, { name: d.name, color: d.role === 'lead' ? d.look.shirt : d.look.accent }]));
  const office = buildOffice(LAYOUT, screens, seatNames);
  world.scene.add(office.root);

  const nav = new NavGraph(LAYOUT.nodes, LAYOUT.edges);
  const spots = new SpotRegistry(LAYOUT.spots);
  const time = new SimTime();
  const clock = new OfficeClock(params.get('clock') === 'demo' ? 'demo' : 'realtime');
  const bubbles = new BubbleLayer();

  const agents = ROSTER.map((def, i) => {
    const agent = new Agent(def, new ProceduralAvatar(def.look, def.role), { nav, spots, time, bubbles }, i);
    agent.place(def.home);
    agent.activity = 'type';
    agent.nextIdle = Math.random() * 6;
    world.scene.add(agent.root);
    return agent;
  });
  const byId = new Map(agents.map((a) => [a.id, a]));

  const sim: Sim = {
    time, spots, fund, clock, agents,
    leads: LEADS.map((d) => byId.get(d.id)!),
    traders: TRADERS.map((d) => byId.get(d.id)!),
    odin: byId.get(ODIN.id)!,
    yama: byId.get(YAMA.id)!,
    log: (msg) => hud.addEvent(msg, clock.time),
  };
  const director = new Director(sim);
  clock.onHour = (h) => director.onHour(h);

  let speed = Number(params.get('speed') ?? 1) || 1;
  let showUpper = true;
  const setClockMode = (m: ClockMode) => clock.setMode(m);

  const hud = new Hud(hudRoot, agents, {
    onCamera: (p) => world.flyTo(p),
    onFollow: (a) => world.follow(a ? a.root : null),
    onScenario: (k) => director.trigger(k),
    onSpeed: (s) => { speed = s; },
    onClockMode: setClockMode,
    onUpperFloor: (v) => { showUpper = v; },
    onTags: (v) => document.body.classList.toggle('hide-tags', !v),
    onAutoplay: (on) => { director.autoplay = on; },
  }, clock.mode, speed);
  bubbles.onLine = (def, text) => hud.addLine(def, text, clock.time);

  installBridge({ agents, director, fund, setClockMode, notify: (m) => hud.toast(m) });

  // Optional user assets: swap in .glb characters / environment as they load.
  const manifest = await loadManifest();
  for (const a of agents) {
    const def = modelFor(manifest, a.def);
    if (!def) continue;
    loadGltfAvatar(def)
      .then((avatar) => a.setAvatar(avatar))
      .catch((err) => console.warn(`[assets] ${def.url} failed, keeping procedural ${a.id}`, err));
  }
  const env = manifest.environment;
  if (env) {
    loadGltf(env.url).then((gltf) => {
      const model = gltf.scene;
      model.scale.setScalar(env.scale ?? 1);
      model.position.set(...(env.position ?? [0, 0, 0]));
      model.rotation.y = env.rotationY ?? 0;
      model.traverse((o) => { o.castShadow = o.receiveShadow = true; });
      world.scene.add(model);
      if (env.hideProcedural) office.root.visible = false;
    }).catch((err) => console.warn(`[assets] environment ${env.url} failed`, err));
  }

  const underSlab = (a: Agent) => {
    const p = a.root.position;
    return a.floor === 0 && p.x > UPPER_SLAB[0] && p.x < UPPER_SLAB[2] && p.z > UPPER_SLAB[1] && p.z < UPPER_SLAB[3];
  };

  let last = performance.now();
  let hudAcc = 1;
  const frame = (now: number) => {
    const real = Math.min(0.1, (now - last) / 1000);
    last = now;
    const dt = real * speed;

    time.advance(dt);
    clock.update(dt);
    fund.tick(dt);
    director.update();
    for (const a of agents) a.update(dt);
    bubbles.update(dt);
    screens.nextReport = director.pendingReport ? 'NOW' : `${String((new Date(clock.time).getHours() + 1) % 24).padStart(2, '0')}:00`;
    screens.update(real);

    // When following someone underneath the upper floor, temporarily hide it.
    const followed = agents.find((a) => a.root === world.followed);
    const upper = showUpper && !(followed && underSlab(followed));
    office.floors[1].visible = upper;
    for (const a of agents) a.setVisible(upper || a.floor === 0);

    world.update(real);
    world.render();

    hudAcc += real;
    if (hudAcc > 0.25) {
      hudAcc = 0;
      hud.update(clock.time, clock.realSecondsToNextHour, director.pendingReport, fund.snapshot(), fund.quiet);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal">${String(err)}</pre>`);
});
