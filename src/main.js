import Globe from 'globe.gl';
import * as THREE from 'three';
import './style.css';

const $ = (id) => document.getElementById(id);
const els = {
  globe: $('globe'), globalStats: $('globalStats'), originSearch: $('originSearch'),
  originResults: $('originResults'), originCard: $('originCard'), airline: $('airlineFilter'),
  minAirlines: $('minAirlines'), minAirlinesVal: $('minAirlinesVal'),
  maxKm: $('maxKm'), maxKmVal: $('maxKmVal'), globalView: $('globalView'),
  oneStop: $('oneStopToggle'), reach: $('reachToggle'), planes: $('planesToggle'), dash: $('dashToggle'), earth: $('earthMode'),
  color: $('colorMode'), legend: $('legendText'),
  rotate: $('rotateToggle'), destTitle: $('destTitle'), destSort: $('destSort'),
  destSearch: $('destSearch'), destList: $('destList'), status: $('statusLine'), routeCard: $('routeCard'),
  targetSearch: $('targetSearch'), targetResults: $('targetResults'),
  oneStopSection: $('oneStopSection'), oneStopTitle: $('oneStopTitle'), oneStopList: $('oneStopList'),
};

const state = {
  origin: 'LHR', dir: 'out', airline: 'ALL', minN: 1, maxKm: 20000,
  global: false, sort: 'n', destQuery: '', showOneStop: false, reachability: false,
  colorMode: 'flow', hoverCode: null, selected: null, pathFocus: null, pathSelected: null,
};
let currentPlanner = null; // { code, type: 'one'|'two', options: [...] }
const effectivePathRank = () => state.pathFocus ?? state.pathSelected;
const focusCode = () => state.selected || state.hoverCode;
let DB = null;
let byIata = new Map();
let routesFrom = new Map();
let routesTo = new Map();
let routePairSet = new Set();
let currentOutCodes = new Set();
let currentInCodes = new Set();
let currentArcs = [];
let currentDirectSet = new Set();
let currentOneStop = new Map();
let currentReach = new Map(); // iata -> flights needed (1=nonstop, 2=one-stop, 3=two-stop)
let hoverPathArcs = [];
let planeData = [];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reducedMotion) { els.rotate.checked = false; els.planes.checked = false; }

/* ---------- day/night globe material ---------- */
function sunLatLng(date = new Date()) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = Math.floor((date.getTime() - start) / 86400000);
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60;
  let lng = 180 - utcHours * 15; // equation-of-time ignored: ±15° visual accuracy
  if (lng > 180) lng -= 360;
  return { lat: decl, lng };
}
function latLngToVec3(lat, lng, r = 1) {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lng + 180) * Math.PI) / 180;
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}
function vec3ToLatLng(v) {
  const r = v.length();
  const lat = 90 - (Math.acos(THREE.MathUtils.clamp(v.y / r, -1, 1)) * 180) / Math.PI;
  let lng = (Math.atan2(v.z, -v.x) * 180) / Math.PI - 180;
  if (lng < -180) lng += 360;
  return { lat, lng };
}
const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');
const dayTex = texLoader.load('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg');
const nightTex = texLoader.load('https://unpkg.com/three-globe/example/img/earth-night.jpg');
dayTex.colorSpace = nightTex.colorSpace = THREE.SRGBColorSpace;
const sunUniforms = {
  dayTexture: { value: dayTex },
  nightTexture: { value: nightTex },
  sunDirection: { value: latLngToVec3(sunLatLng().lat, sunLatLng().lng) },
  overrideMix: { value: -1 }, // -1 = live terminator, 0 = night, 1 = day
};
const globeMaterial = new THREE.ShaderMaterial({
  uniforms: sunUniforms,
  vertexShader: `
    varying vec2 vUv; varying vec3 vObjNormal;
    void main() {
      vUv = uv; vObjNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform sampler2D dayTexture; uniform sampler2D nightTexture;
    uniform vec3 sunDirection; uniform float overrideMix;
    varying vec2 vUv; varying vec3 vObjNormal;
    void main() {
      float m = overrideMix;
      if (m < 0.0) {
        float i = dot(normalize(vObjNormal), normalize(sunDirection));
        m = smoothstep(-0.12, 0.25, i);
      }
      vec4 day = texture2D(dayTexture, vUv);
      vec4 night = texture2D(nightTexture, vUv) * 1.35;
      gl_FragColor = vec4(mix(night.rgb, day.rgb, m) * 1.45, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
function updateSun() {
  const s = sunLatLng();
  sunUniforms.sunDirection.value.copy(latLngToVec3(s.lat, s.lng));
}
const sunTimer = setInterval(updateSun, 60000);

/* ---------- globe ---------- */
// If WebGL context creation fails (no GPU acceleration, or the browser's
// live-context limit is exhausted by leaked renderers/other tabs), degrade
// to a no-op globe: panels, lists, search and route cards keep working.
let webglFailed = false;
function createGlobeStub() {
  const stub = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'controls') return () => ({});
      if (prop === 'renderer') return () => null;
      return () => stub;
    },
    set() { return true; },
  });
  return stub;
}
function showWebglFallback() {
  els.globe.innerHTML = `<div class="webgl-fallback">
    <h2>3D globe unavailable</h2>
    <p>Your browser refused a WebGL context. This usually means too many WebGL tabs/contexts are open, or hardware acceleration is off.</p>
    <p>Close other FlightAtlas / 3D tabs, then retry. All search, lists and route cards still work without the globe.</p>
    <button type="button" id="retryGlobe">Retry globe</button>
  </div>`;
  document.getElementById('retryGlobe')?.addEventListener('click', () => window.location.reload());
}
function arcColors(d) {
  if (d.kind === 'path') {
    const eff = effectivePathRank();
    if (eff !== null && d.pathRank !== eff) return ['rgba(199,146,255,0.10)', 'rgba(199,146,255,0.10)'];
    if (d.pathRank === 0 || d.pathRank === eff) return ['#ffffff', '#c792ff'];
    const alpha = Math.max(0.25, 0.75 - d.pathRank * 0.08);
    return [`rgba(230,200,255,${alpha})`, `rgba(199,146,255,${alpha})`];
  }
  if (d.oneWay && !state.global && state.dir !== 'both' && !focusCode()) return ['#ff6ec7', '#ffb3e2'];
  if (focusCode() && d.other !== focusCode()) return ['rgba(110,170,230,0.07)', 'rgba(110,170,230,0.07)'];
  switch (state.colorMode) {
    case 'volume': {
      const c = ['#3ec6ff', '#3ec6ff', '#37e0a0', '#b8e356', '#ffc857', '#ff8a5b'][Math.min(d.n, 5)] || '#ff5470';
      return d.n >= 6 ? ['#ff8a5b', '#ff5470'] : [c, c];
    }
    case 'distance': {
      const c = d.km < 1000 ? '#53d8fb' : d.km < 3000 ? '#7a8cff' : d.km < 6000 ? '#b46cff' : d.km < 10000 ? '#ff6ec7' : '#ff5470';
      return [c, c];
    }
    case 'direction':
      return d.fromOrigin ? ['#ffb454', '#ffb454'] : ['#53d8fb', '#53d8fb'];
    default:
      return d.fromOrigin ? ['rgba(255,180,84,0.9)', 'rgba(83,216,251,0.9)'] : ['rgba(83,216,251,0.75)', 'rgba(255,180,84,0.75)'];
  }
}

let globe;
try {
  globe = Globe()(els.globe)
  .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png')
  .globeMaterial(globeMaterial)
  .showAtmosphere(true)
  .atmosphereColor('#6fb7ff')
  .atmosphereAltitude(0.18)
  .pointAltitude((d) => 0.01 + Math.min(0.05, d.services / 4000))
  .pointRadius((d) => {
    if (d.iata === focusCode()) return 0.85;
    if (d.iata === state.origin) return 0.65;
    return 0.22 + Math.min(0.35, d.services / 900);
  })
  .pointColor((d) => {
    if (d.iata === state.origin) return '#ffb454';
    if (d.iata === focusCode()) return '#ffffff';
    if (state.reachability && currentReach.size) {
      const lvl = currentReach.get(d.iata);
      if (lvl === 1) return '#53d8fb';
      if (lvl === 2) return '#c792ff';
      if (lvl === 3) return '#ff8a5b';
      return 'rgba(170,215,255,0.16)';
    }
    if (currentDirectSet.has(d.iata)) return '#53d8fb';
    if (currentOneStop.has(d.iata)) return '#c792ff';
    return 'rgba(170,215,255,0.45)';
  })
  .pointLabel((d) => {
    const os = currentOneStop.get(d.iata);
    const lvl = currentReach.get(d.iata);
    const reachTxt = state.reachability && currentReach.size
      ? `<br/>${lvl === 1 ? `Nonstop from ${state.origin}` : lvl === 2 ? `1 stop from ${state.origin}` : lvl === 3 ? `2 stops from ${state.origin}` : `Not reachable within 2 stops from ${state.origin}`}`
      : '';
    return `<div class="tip"><b>${d.iata}</b> ${d.city}<br/>${d.name}<br/>${d.dests} nonstop destinations${os ? `<br/>One-stop from ${state.origin} via ${os.via}` : ''}${reachTxt}</div>`;
  })
  .onPointClick((d) => {
    if (currentDirectSet.has(d.iata) || currentOneStop.has(d.iata)) setSelected(d.iata);
    else setOrigin(d.iata, true);
  })
  .onPointHover((d) => setHover(d ? d.iata : null))
  .arcStartLat((d) => d.slat).arcStartLng((d) => d.slng)
  .arcEndLat((d) => d.dlat).arcEndLng((d) => d.dlng)
  .arcColor(arcColors)
  .arcStroke((d) => {
    if (d.kind === 'path') {
      const eff = effectivePathRank();
      if (eff !== null) return d.pathRank === eff ? 1.05 : 0.3;
      return d.pathRank === 0 ? 0.85 : 0.5;
    }
    const base = 0.18 + Math.sqrt(d.n) * 0.38;
    return focusCode() && d.other === focusCode() ? base + 0.55 : base;
  })
  .arcAltitudeAutoScale(0.45)
  .arcDashLength(() => (els.dash.checked ? 0.35 : 1))
  .arcDashGap(() => (els.dash.checked ? 0.18 : 0))
  .arcDashAnimateTime(() => (els.dash.checked && currentArcs.length <= 250 && !reducedMotion ? 1600 : 0))
  .arcLabel((d) => `<div class="tip"><b>${d.s} → ${d.d}</b><br/>${d.km.toLocaleString()} km · ${d.n} airline${d.n === 1 ? '' : 's'}<br/>${d.airlineNames}${d.oneWay ? '<br/>One-way in data — no return route listed' : ''}</div>`)
  .onArcClick((d) => setSelected(d.other))
  .onArcHover((d) => setHover(d ? d.other : null))
  .ringsData([])
  .ringColor(() => 'rgba(255,180,84,0.85)')
  .ringMaxRadius(4).ringPropagationSpeed(1.6).ringRepeatPeriod(900)
  .objectsData([])
  .objectLat('lat').objectLng('lng').objectAltitude('alt')
  .objectLabel((d) => `<div class="tip">✈ ${d.route.s} → ${d.route.d}<br/>${d.route.airlineNames}</div>`)
  .customThreeObject(() => {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff0c2 })
    );
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1.15, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.35 })
    );
    g.add(core, halo);
    return g;
  });
} catch (err) {
  console.warn('WebGL globe failed to start; continuing without it.', err);
  webglFailed = true;
  globe = createGlobeStub();
  showWebglFallback();
}

globe.controls().autoRotateSpeed = 0.55;
// Cap render resolution: full retina (2x-3x) quadruples fragment work for
// almost no visible gain on a textured globe.
if (!webglFailed) {
  try { globe.renderer()?.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.5)); } catch { /* stub */ }
}

/* Idle/visibility power management: three.js renders continuously by
   default. Pause it when the tab is hidden, and after 15s of no interaction
   when neither auto-rotate nor aircraft animation needs motion. */
let idlePaused = false;
let lastActivity = Date.now();
function noteActivity() {
  lastActivity = Date.now();
  if (idlePaused && !document.hidden && !webglFailed) {
    idlePaused = false;
    try { globe.resumeAnimation?.(); } catch { /* stub */ }
  }
}
const activityTimer = setInterval(() => {
  if (idlePaused || webglFailed || document.hidden) return;
  if (!els.rotate.checked && !els.planes.checked && Date.now() - lastActivity > 15000) {
    idlePaused = true;
    try { globe.pauseAnimation?.(); } catch { /* stub */ }
  }
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (webglFailed) return;
  if (document.hidden) {
    try { globe.pauseAnimation?.(); } catch { /* stub */ }
    stopPlaneLoop();
  } else {
    try { globe.resumeAnimation?.(); } catch { /* stub */ }
    idlePaused = false;
    noteActivity();
    startPlaneLoop();
  }
});

let idleTimer;
function applyRotation() { globe.controls().autoRotate = els.rotate.checked && !reducedMotion; }
els.globe.addEventListener('pointerdown', () => {
  noteActivity();
  globe.controls().autoRotate = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(applyRotation, 5000);
});
els.globe.addEventListener('wheel', noteActivity, { passive: true });
function onResize() { globe.width(window.innerWidth).height(window.innerHeight); }
window.addEventListener('resize', onResize);
onResize();

// Release the WebGL context on page hide / Vite hot-reload. Without this,
// every HMR cycle leaks a renderer until the browser hits its live WebGL
// context limit (~8-16) and Globe creation throws
// "THREE.WebGLRenderer: Error creating WebGL context".
let destroyed = false;
function destroyGlobe() {
  if (destroyed) return;
  destroyed = true;
  stopPlaneLoop();
  clearInterval(sunTimer);
  clearInterval(activityTimer);
  window.removeEventListener('resize', onResize);
  try {
    globe.pauseAnimation?.();
    const renderer = globe.renderer?.();
    renderer?.forceContextLoss?.();
    renderer?.dispose?.();
  } catch { /* already gone */ }
  els.globe.innerHTML = '';
}
window.addEventListener('pagehide', destroyGlobe);
if (import.meta.hot) import.meta.hot.dispose(destroyGlobe);

/* ---------- data ---------- */
function indexRoutes(routes) {
  routesFrom = new Map(); routesTo = new Map();
  routePairSet = new Set(routes.map((r) => `${r.s}>${r.d}`));
  for (const r of routes) {
    if (!routesFrom.has(r.s)) routesFrom.set(r.s, []);
    if (!routesTo.has(r.d)) routesTo.set(r.d, []);
    routesFrom.get(r.s).push(r); routesTo.get(r.d).push(r);
  }
}
function arcFor(r, fromOrigin, kind = 'direct') {
  const s = byIata.get(r.s), d = byIata.get(r.d);
  return {
    ...r, slat: s.lat, slng: s.lng, dlat: d.lat, dlng: d.lng, kind,
    oneWay: !routePairSet.has(`${r.d}>${r.s}`),
    fromOrigin, other: fromOrigin ? r.d : r.s,
    airlineNames: r.a.map((c) => DB.airlines[c] || c).join(', '),
  };
}
function rawRoutesForOrigin() {
  const out = (routesFrom.get(state.origin) || []).map((r) => arcFor(r, true));
  const inn = (routesTo.get(state.origin) || []).map((r) => arcFor(r, false));
  if (state.dir === 'out') return out;
  if (state.dir === 'in') return inn;
  return [...out, ...inn];
}
function passes(r) {
  return r.n >= state.minN && r.km <= state.maxKm &&
    (state.airline === 'ALL' || r.a.includes(state.airline));
}
function computeArcs() {
  if (state.global) {
    return DB.routes.filter(passes)
      .sort((a, b) => b.n - a.n || b.km - a.km).slice(0, 600)
      .map((r) => ({ ...arcFor(r, r.s === state.origin), other: r.d }));
  }
  return rawRoutesForOrigin().filter(passes);
}

/* One-stop reachability through the currently shown nonstop network.
   Both legs must pass the active airline / min-airlines / distance filters. */
function computeOneStop(directArcs) {
  const result = new Map();
  if (state.global || !state.showOneStop || state.dir === 'both') return result;
  const directCodes = new Set(directArcs.map((a) => a.other));
  const hubsByDest = new Map();
  const consider = (dest, via, leg1, leg2) => {
    if (dest === state.origin || directCodes.has(dest)) return;
    if (!hubsByDest.has(dest)) hubsByDest.set(dest, new Set());
    hubsByDest.get(dest).add(via);
    const score = leg1.n + leg2.n;
    const prev = result.get(dest);
    if (!prev || score > prev.score) {
      result.set(dest, {
        code: dest, via, leg1, leg2, score,
        km: leg1.km + leg2.km, hubCount: 0,
      });
    }
  };
  for (const a of directArcs) {
    if (state.dir === 'out') {
      for (const r of routesFrom.get(a.other) || []) if (passes(r)) consider(r.d, a.other, a, r);
    } else { // 'in': paths ending at origin — reachable origins via a hub
      for (const r of routesTo.get(a.other) || []) if (passes(r)) consider(r.s, a.other, r, a);
    }
  }
  for (const [code, info] of result) info.hubCount = hubsByDest.get(code)?.size || 1;
  return result;
}

/* Reachability: BFS from the origin over the filtered network, up to
   3 flights (nonstop / 1-stop / 2-stop). Respects active filters. */
function computeReach() {
  const result = new Map();
  if (state.global || !state.reachability || state.dir === 'both') return result;
  result.set(state.origin, 0);
  let frontier = [state.origin];
  for (let lvl = 1; lvl <= 3 && frontier.length; lvl++) {
    const next = [];
    for (const code of frontier) {
      const routes = (state.dir === 'in' ? routesTo.get(code) : routesFrom.get(code)) || [];
      for (const r of routes) {
        if (!passes(r)) continue;
        const nb = state.dir === 'in' ? r.s : r.d;
        if (!result.has(nb)) { result.set(nb, lvl); next.push(nb); }
      }
    }
    frontier = next;
  }
  return result;
}

/* ---------- hover + pair selection (list <-> globe) ---------- */
function displayArcs() { return [...currentArcs, ...hoverPathArcs]; }
function refreshHighlight() {
  const code = focusCode();
  hoverPathArcs = [];
  const info = code ? currentOneStop.get(code) : null;
  if (info) {
    hoverPathArcs = state.dir === 'in'
      ? [arcFor(info.leg1, false, 'path'), arcFor(info.leg2, false, 'path')]
      : [arcFor(info.leg1, true, 'path'), arcFor(info.leg2, true, 'path')];
    hoverPathArcs.forEach((a) => { a.other = code; });
  } else if (code && state.selected === code && !state.global &&
             !currentArcs.some((a) => a.other === code)) {
    // Planner target with no direct arc: draw ALL connection options,
    // best-ranked brightest; shared legs drawn once (best rank wins).
    const ones = oneStopOptions(code);
    const optionLegs = ones.length
      ? ones.map((o) => [o.leg1, o.leg2])
      : twoStopOptions(code).map((o) => o.legs);
    const byLeg = new Map();
    optionLegs.forEach((legs, rank) => {
      for (const leg of legs) {
        const key = `${leg.s}>${leg.d}`;
        if (byLeg.has(key)) continue;
        const arc = leg.slat !== undefined ? { ...leg } : arcFor(leg, state.dir !== 'in', 'path');
        arc.kind = 'path'; arc.other = code; arc.pathRank = rank;
        byLeg.set(key, arc);
      }
    });
    hoverPathArcs = [...byLeg.values()];
  }
  globe.arcsData(displayArcs());
  if (DB) globe.pointsData(DB.airports);
  document.querySelectorAll('#destList button, #oneStopList button').forEach((b) => {
    b.classList.toggle('highlight', b.dataset.code === state.hoverCode);
    b.classList.toggle('selected', b.dataset.code === state.selected);
  });
}
function setHover(code) {
  if (state.hoverCode === code) return;
  state.hoverCode = code;
  refreshHighlight();
}
function setSelected(code) {
  state.selected = code;
  state.pathFocus = null;
  state.pathSelected = null;
  refreshHighlight();
  renderRouteCard();
}

/* ---------- route detail card + Kayak ---------- */
function haversineKm(a, b) {
  const p = Math.PI / 180;
  const h = 0.5 - Math.cos((b.lat - a.lat) * p) / 2 +
    Math.cos(a.lat * p) * Math.cos(b.lat * p) * (1 - Math.cos((b.lng - a.lng) * p)) / 2;
  return Math.round(12742 * Math.asin(Math.sqrt(Math.max(0, h))));
}
function estFlightTime(km) {
  const mins = Math.round(km / 13.5 + 35); // ~810 km/h cruise + taxi/climb allowance
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
function estCO2(km) {
  const f = km < 1500 ? 0.16 : km < 4000 ? 0.12 : 0.11; // kg per passenger-km, rough DEFRA-style
  return Math.round(km * f);
}
/* IATA equipment code -> aircraft name (covers all codes in the data). */
const EQUIPMENT = {
  // Airbus
  '310': 'Airbus A310', '313': 'Airbus A310-300', '318': 'Airbus A318', '319': 'Airbus A319',
  '320': 'Airbus A320', '321': 'Airbus A321', '32A': 'Airbus A320 (Sharklets)', '32B': 'Airbus A321 (Sharklets)',
  '32C': 'Airbus A318 (Sharklets)', '32S': 'Airbus A320 family', '330': 'Airbus A330', '332': 'Airbus A330-200',
  '333': 'Airbus A330-300', '33X': 'Airbus A330', '340': 'Airbus A340', '342': 'Airbus A340-200',
  '343': 'Airbus A340-300', '345': 'Airbus A340-500', '346': 'Airbus A340-600', '351': 'Airbus A350-1000',
  '359': 'Airbus A350-900', '380': 'Airbus A380', '388': 'Airbus A380-800', 'AB4': 'Airbus A300B4',
  'AB6': 'Airbus A300-600', 'A81': 'Airbus A310',
  // Boeing
  '717': 'Boeing 717', '732': 'Boeing 737-200', '733': 'Boeing 737-300', '734': 'Boeing 737-400',
  '735': 'Boeing 737-500', '736': 'Boeing 737-600', '737': 'Boeing 737', '738': 'Boeing 737-800',
  '739': 'Boeing 737-900', '73C': 'Boeing 737-300', '73G': 'Boeing 737-700', '73H': 'Boeing 737-800 (winglets)',
  '73J': 'Boeing 737-900', '73M': 'Boeing 737-200 Combi', '73N': 'Boeing 737-700', '73Q': 'Boeing 737-200QC',
  '73R': 'Boeing 737-200', '73W': 'Boeing 737-700 (winglets)', '747': 'Boeing 747', '744': 'Boeing 747-400',
  '74E': 'Boeing 747-400 Combi', '74H': 'Boeing 747-8', '74L': 'Boeing 747SP', '74M': 'Boeing 747-200 Combi',
  '74N': 'Boeing 747-100', '74Y': 'Boeing 747-200 Freighter', '752': 'Boeing 757-200', '753': 'Boeing 757-300',
  '757': 'Boeing 757', '75T': 'Boeing 757-200', '75W': 'Boeing 757-200 (winglets)', '762': 'Boeing 767-200',
  '763': 'Boeing 767-300', '764': 'Boeing 767-400', '767': 'Boeing 767', '76W': 'Boeing 767-300ER (winglets)',
  '772': 'Boeing 777-200', '773': 'Boeing 777-300', '777': 'Boeing 777', '77L': 'Boeing 777-200LR',
  '77W': 'Boeing 777-300ER', '77X': 'Boeing 777-200', '787': 'Boeing 787 Dreamliner', '788': 'Boeing 787-8',
  '789': 'Boeing 787-9',
  // McDonnell Douglas / Fokker / other jets
  'M80': 'McDonnell Douglas MD-80', 'M82': 'McDonnell Douglas MD-82', 'M83': 'McDonnell Douglas MD-83',
  'M87': 'McDonnell Douglas MD-87', 'M88': 'McDonnell Douglas MD-88', 'M90': 'McDonnell Douglas MD-90',
  'M11': 'McDonnell Douglas MD-11', 'M1F': 'McDonnell Douglas MD-11 Freighter', 'DC9': 'Douglas DC-9',
  'D93': 'Douglas DC-9-30', '100': 'Fokker 100', 'F28': 'Fokker F28', 'F50': 'Fokker 50', 'F70': 'Fokker 70',
  '146': 'BAe 146', '141': 'BAe 146-100', '142': 'BAe 146-200', '143': 'BAe 146-300',
  'AR1': 'Avro RJ70', 'AR8': 'Avro RJ85', 'IL9': 'Ilyushin Il-96', 'TU3': 'Tupolev Tu-134',
  'TU5': 'Tupolev Tu-154', 'T20': 'Tupolev Tu-204', 'SU9': 'Sukhoi Superjet 100',
  'YK2': 'Yakovlev Yak-42', 'YK4': 'Yakovlev Yak-40', 'AN4': 'Antonov An-24', 'A40': 'Antonov An-140',
  // Regional jets
  'CR1': 'Bombardier CRJ100', 'CR2': 'Bombardier CRJ200', 'CR7': 'Bombardier CRJ700',
  'CR9': 'Bombardier CRJ900', 'CRJ': 'Bombardier CRJ', 'CRK': 'Bombardier CRJ1000',
  'E70': 'Embraer E170', 'E75': 'Embraer E175', 'E90': 'Embraer E190', 'E95': 'Embraer E195',
  'EMJ': 'Embraer E-Jet', 'ER3': 'Embraer ERJ-135', 'ER4': 'Embraer ERJ-145', 'ERD': 'Embraer ERJ-140',
  'ERJ': 'Embraer ERJ', 'FRJ': 'Fairchild Dornier 328JET',
  // Turboprops & pistons
  'AT4': 'ATR 42-300', 'AT5': 'ATR 42-500', 'AT7': 'ATR 72', 'ATR': 'ATR 42/72', 'ATP': 'BAe ATP',
  'DH1': 'de Havilland Canada DHC-8-100', 'DH2': 'de Havilland Canada DHC-8-200',
  'DH3': 'de Havilland Canada DHC-8-300', 'DH4': 'de Havilland Canada DHC-8-400 (Q400)',
  'DH7': 'de Havilland Canada DHC-7', 'DH8': 'de Havilland Canada DHC-8', 'DHT': 'de Havilland Canada DHC-6 Twin Otter',
  'D28': 'Dornier 228', 'D38': 'Dornier 328', 'EMB': 'Embraer EMB-110 Bandeirante', 'EM2': 'Embraer EMB-120 Brasilia',
  'SF3': 'Saab 340', 'S20': 'Saab 2000', 'SFB': 'Saab Fairchild 340', 'BE1': 'Beechcraft 1900',
  'BEH': 'Beechcraft 1900D', 'BET': 'Beechcraft turboprop', 'BNI': 'Britten-Norman Islander',
  'BNT': 'Britten-Norman Trislander', 'BH2': 'Bell 206', 'J31': 'BAe Jetstream 31', 'J32': 'BAe Jetstream 32',
  'J41': 'BAe Jetstream 41', 'L4T': 'Let L-410 Turbolet', 'MA6': 'Xian MA60', 'PL2': 'Pilatus PC-12',
  'SWM': 'Fairchild Metroliner', 'SH6': 'Short 360', 'CNA': 'Cessna (single-engine)', 'CNJ': 'Cessna CitationJet',
  'CNC': 'Cessna Caravan', 'CNT': 'Cessna twin-engine', 'PA2': 'Piper twin-engine',
  'YN2': 'Harbin Y-12', 'YN7': 'Yunshuji Y-7', 'I14': 'Ilyushin Il-14',
};
function equipmentNames(codes) {
  return [...new Set((codes || []).map((c) => EQUIPMENT[c] || c))].join(', ');
}
function kayakUrl(code) {
  const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  return `https://www.kayak.com/flights/${state.origin}-${code}/${date}?sort=bestflight_a`;
}
function oneStopOptions(code) {
  const opts = [];
  const directCodes = new Set(currentArcs.map((a) => a.other));
  if (directCodes.has(code)) return opts;
  for (const a of currentArcs) {
    const legs = state.dir === 'in' ? routesTo.get(a.other) || [] : routesFrom.get(a.other) || [];
    for (const r of legs) {
      const dest = state.dir === 'in' ? r.s : r.d;
      if (dest === code && passes(r)) {
        opts.push({ via: a.other, score: a.n + r.n, km: a.km + r.km, leg1: a, leg2: r });
      }
    }
  }
  const bestByVia = new Map();
  for (const o of opts) if (!bestByVia.has(o.via) || o.score > bestByVia.get(o.via).score) bestByVia.set(o.via, o);
  return [...bestByVia.values()].sort((x, y) => x.km - y.km || y.score - x.score).slice(0, 8);
}
function twoStopOptions(code) {
  const opts = [];
  if (state.global || state.dir === 'both') return opts;
  const directSet = new Set(currentArcs.map((a) => a.other));
  if (directSet.has(code)) return opts;
  const arcByOther = new Map(currentArcs.map((a) => [a.other, a]));
  const finalLegs = (state.dir === 'in' ? routesFrom.get(code) : routesTo.get(code)) || [];
  for (const leg3 of finalLegs) {
    if (!passes(leg3)) continue;
    const h2 = state.dir === 'in' ? leg3.d : leg3.s;
    const midLegs = (state.dir === 'in' ? routesFrom.get(h2) : routesTo.get(h2)) || [];
    for (const leg2 of midLegs) {
      if (!passes(leg2)) continue;
      const h1 = state.dir === 'in' ? leg2.d : leg2.s;
      if (!directSet.has(h1) || h1 === code || h2 === code) continue;
      const leg1 = arcByOther.get(h1);
      opts.push({
        via: [h1, h2], legs: [leg1, leg2, leg3],
        km: leg1.km + leg2.km + leg3.km, score: leg1.n + leg2.n + leg3.n,
      });
    }
  }
  const best = new Map();
  for (const o of opts) {
    const k = o.via.join('>');
    if (!best.has(k) || o.score > best.get(k).score) best.set(k, o);
  }
  return [...best.values()].sort((a, b) => a.km - b.km || b.score - a.score).slice(0, 5);
}
function oneSummaryHTML(o, code, gcKm) {
  return `<span class="badge onestop">One-stop via ${o.via}</span>
    <dl><dt>Total distance</dt><dd>${o.km.toLocaleString()} km (${Math.round((o.km / gcKm - 1) * 100)}% detour vs ${gcKm.toLocaleString()} km direct line)</dd>
    <dt>Est. flying time</dt><dd>${estFlightTime(o.km)} + layover (estimate)</dd>
    <dt>Routing</dt><dd>${state.origin} → ${o.via} → ${code}</dd></dl>`;
}
function twoSummaryHTML(o, code, gcKm) {
  return `<span class="badge onestop">Two stops via ${o.via.join(' + ')}</span>
    <dl><dt>Total distance</dt><dd>${o.km.toLocaleString()} km (${Math.round((o.km / gcKm - 1) * 100)}% detour vs ${gcKm.toLocaleString()} km direct line)</dd>
    <dt>Est. flying time</dt><dd>${estFlightTime(o.km)} + layovers (estimate)</dd>
    <dt>Routing</dt><dd>${state.origin} → ${o.via[0]} → ${o.via[1]} → ${code}</dd></dl>`;
}
function updateRouteSummary() {
  const el = document.getElementById('routeSummary');
  if (!el || !currentPlanner) return;
  const rank = effectivePathRank() ?? 0;
  const o = currentPlanner.options[rank];
  if (!o) return;
  const dest = byIata.get(currentPlanner.code);
  const gcKm = haversineKm(byIata.get(state.origin), dest);
  el.innerHTML = currentPlanner.type === 'one'
    ? oneSummaryHTML(o, currentPlanner.code, gcKm)
    : twoSummaryHTML(o, currentPlanner.code, gcKm);
  els.routeCard.querySelectorAll('.path-option').forEach((b) =>
    b.classList.toggle('selected-option', +b.dataset.rank === state.pathSelected));
}
function renderRouteCard() {
  const code = state.selected;
  currentPlanner = null;
  if (!code || state.global) { els.routeCard.hidden = true; els.routeCard.innerHTML = ''; return; }
  const dest = byIata.get(code);
  const origin = byIata.get(state.origin);
  const direct = currentArcs.find((a) => a.other === code);
  const osInfo = currentOneStop.get(code);
  const options = direct ? [] : oneStopOptions(code);
  const bestOS = options[0];
  const twos = direct || bestOS ? [] : twoStopOptions(code);
  if (bestOS) currentPlanner = { code, type: 'one', options };
  else if (twos.length) currentPlanner = { code, type: 'two', options: twos };
  const gcKm = haversineKm(origin, dest);
  let body = '';
  if (direct) {
    body = `<span class="badge">Nonstop</span>
      <dl><dt>Distance</dt><dd>${direct.km.toLocaleString()} km</dd>
      <dt>Est. flight time</dt><dd>${estFlightTime(direct.km)} (estimate)</dd>
      <dt>Airlines</dt><dd>${direct.a.map((c) => `${DB.airlines[c] || c} (${c})`).join(', ')}</dd>
      <dt>Aircraft types</dt><dd>${equipmentNames(direct.eq) || '—'}</dd>
      <dt>CO₂ / passenger</dt><dd>≈ ${estCO2(direct.km)} kg (rough estimate)</dd></dl>`;
  } else if (bestOS) {
    body = `<div id="routeSummary">${oneSummaryHTML(bestOS, code, gcKm)}</div>
      <b>Connection options (${options.length}) — hover or click to inspect</b><ul>${options.map((o, i) =>
        `<li><button type="button" class="path-option" data-rank="${i}">${state.origin} → ${o.via} → ${code} — ${o.leg1.a.join('/')} then ${o.leg2.a.join('/')} · ${o.km.toLocaleString()} km</button></li>`).join('')}</ul>`;
  } else if (twos.length) {
    body = `<div id="routeSummary">${twoSummaryHTML(twos[0], code, gcKm)}</div>
      <b>Connection options (${twos.length}) — hover or click to inspect</b><ul>${twos.map((o, i) =>
        `<li><button type="button" class="path-option" data-rank="${i}">${state.origin} → ${o.via[0]} → ${o.via[1]} → ${code} — ${o.legs.map((l) => l.a.join('/')).join(' then ')} · ${o.km.toLocaleString()} km</button></li>`).join('')}</ul>`;
  } else {
    body = `<span class="badge onestop">No route under current filters</span>
      <dl><dt>Direct-line distance</dt><dd>${gcKm.toLocaleString()} km</dd></dl>
      <p>Lower the minimum-airline count, raise max distance, or clear the airline filter.</p>`;
  }
  els.routeCard.innerHTML = `
    <h3>${state.origin} → ${code}</h3>
    <div>${dest.city}, ${dest.country} — ${dest.name}</div>
    ${body}
    ${wikiBlock(dest)}
    <div class="actions">
      <a class="kayak" href="${kayakUrl(code)}" target="_blank" rel="noopener">See live fares on KAYAK ↗</a>
      ${dest.wiki ? `<a class="wiki" href="${dest.wiki}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}
      <button type="button" class="pivot" id="pivotBtn">Explore from ${code}</button>
      <button type="button" class="clear" id="clearSelBtn">Clear</button>
    </div>`;
  els.routeCard.hidden = false;
  els.routeCard.querySelectorAll('.path-option').forEach((b) => {
    b.addEventListener('mouseenter', () => { state.pathFocus = +b.dataset.rank; refreshHighlight(); updateRouteSummary(); });
    b.addEventListener('click', () => {
      state.pathSelected = +b.dataset.rank;
      state.pathFocus = +b.dataset.rank;
      refreshHighlight(); updateRouteSummary();
    });
    b.addEventListener('mouseleave', () => { state.pathFocus = null; refreshHighlight(); updateRouteSummary(); });
  });
  ensureAbstract(dest);
  $('pivotBtn').addEventListener('click', () => setOrigin(code, true));
  $('clearSelBtn').addEventListener('click', () => setSelected(null));
}

/* ---------- animated aircraft ---------- */
let planeRaf = 0;
let planeLoopRunning = false;
let lastPlaneUpdate = 0;
function startPlaneLoop() {
  if (planeLoopRunning || webglFailed || !els.planes.checked || reducedMotion || document.hidden) return;
  planeLoopRunning = true;
  planeRaf = requestAnimationFrame(planeTick);
}
function stopPlaneLoop() {
  planeLoopRunning = false;
  cancelAnimationFrame(planeRaf);
}
function setupPlanes() {
  planeData = [];
  if (!els.planes.checked || reducedMotion || !currentArcs.length) { stopPlaneLoop(); globe.objectsData([]); return; }
  const top = [...currentArcs].sort((a, b) => b.n - a.n || b.km - a.km).slice(0, 10);
  planeData = top.map((route, i) => ({
    route,
    v1: latLngToVec3(route.slat, route.slng),
    v2: latLngToVec3(route.dlat, route.dlng),
    offset: (i * 0.137) % 1,
    duration: THREE.MathUtils.clamp(route.km * 2.2, 7000, 22000),
    lat: route.slat, lng: route.slng, alt: 0.02,
  }));
  globe.objectsData(planeData);
  startPlaneLoop();
}
const _sv = new THREE.Vector3();
function planeTick(ts) {
  if (!planeLoopRunning) return;
  planeRaf = requestAnimationFrame(planeTick);
  if (ts - lastPlaneUpdate < 66) return; // ~15fps is plenty for aircraft dots
  lastPlaneUpdate = ts;
  if (planeData.length && els.planes.checked && !document.hidden) {
    for (const p of planeData) {
      const t = ((ts / p.duration) + p.offset) % 1;
      _sv.copy(p.v1).multiplyScalar(1 - t).addScaledVector(p.v2, t).normalize();
      // slerp-corrected interpolation point
      const angle = p.v1.angleTo(p.v2);
      const s = Math.sin(angle) || 1e-6;
      _sv.copy(p.v1).multiplyScalar(Math.sin((1 - t) * angle) / s)
        .addScaledVector(p.v2, Math.sin(t * angle) / s);
      const { lat, lng } = vec3ToLatLng(_sv);
      p.lat = lat; p.lng = lng;
      p.alt = 0.02 + Math.sin(Math.PI * t) * (0.05 + Math.min(0.3, p.route.km / 45000));
    }
    globe.objectsData(planeData);
  }
}

/* ---------- UI ---------- */
function setOrigin(iata, fly) {
  if (!byIata.has(iata)) return;
  state.origin = iata;
  els.targetSearch.value = '';
  state.airline = 'ALL';
  state.hoverCode = null; hoverPathArcs = [];
  buildAirlineOptions();
  render(fly);
}
function buildAirlineOptions() {
  const codes = new Set();
  for (const r of rawRoutesForOrigin()) r.a.forEach((c) => codes.add(c));
  const opts = [...codes].sort((a, b) => (DB.airlines[a] || a).localeCompare(DB.airlines[b] || b));
  els.airline.innerHTML = '<option value="ALL">All airlines</option>' +
    opts.map((c) => `<option value="${c}">${DB.airlines[c] || c} (${c})</option>`).join('');
  els.airline.value = state.airline;
}

function wikiBlock(ap) {
  if (!ap.abstract && !ap.image) return '';
  return `<div class="wiki-media">
    ${ap.image ? `<img src="${ap.image}" alt="${ap.name}" loading="lazy" referrerpolicy="no-referrer" />` : ''}
    ${ap.abstract ? `<p>${ap.abstract}</p>` : ''}
  </div>`;
}
function setOriginCard() {
  const origin = byIata.get(state.origin);
  if (!origin) return;
  els.originCard.innerHTML = state.global
    ? `<div class="code">GLOBAL</div><div><b>Busiest routes worldwide</b><br/><small>Top ${currentArcs.length} by airline count. Untick global view or click an airport to explore one origin.</small></div>`
    : `<div class="code">${origin.iata}</div><div><b>${origin.city}</b> — ${origin.country}<br/><small>${origin.name}</small>
      ${wikiBlock(origin)}
      ${origin.wiki ? `<br/><a class="wiki" href="${origin.wiki}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ''}</div>`;
}

/* Wikipedia abstracts load lazily per viewed airport (bulk fetch rate-limits). */
const wikiPending = new Set();
async function ensureAbstract(ap) {
  if (!ap?.wiki || ap.abstract || wikiPending.has(ap.iata)) return;
  wikiPending.add(ap.iata);
  try {
    const u = new URL(ap.wiki);
    const title = decodeURIComponent(u.pathname.split('/wiki/')[1] || '');
    const host = u.hostname.replace('.m.', '.');
    const res = await fetch(`https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
    if (!res.ok) return;
    const data = await res.json();
    let text = (data.extract || '').trim();
    if (text.length > 1400) text = text.slice(0, 1350).replace(/\s+\S*$/, '') + '…';
    ap.image = data.thumbnail?.source || data.originalimage?.source || ap.image;
    if (text) ap.abstract = text;
    if (text || ap.image) {
      if (state.origin === ap.iata) setOriginCard();
      if (state.selected === ap.iata) renderRouteCard();
    }
  } catch { /* offline / no article: link alone still renders */ } finally {
    wikiPending.delete(ap.iata);
  }
}

const LEGENDS = {
  flow: 'Arcs shade from amber at the origin to cyan at the destination. Thicker = more airlines on the route.',
  volume: 'Arc colour and thickness both encode airlines per route: blue (1) through green/yellow to red (6+).',
  distance: 'Arc colour encodes distance: cyan short-haul through violet to red ultra-long-haul (10,000+ km).',
  direction: 'Amber arcs leave the origin, cyan arcs arrive. Thicker = more airlines on the route.',
};
function render(flyToOrigin = false) {
  noteActivity();
  const origin = byIata.get(state.origin);
  state.hoverCode = null; state.selected = null; state.pathFocus = null; state.pathSelected = null; hoverPathArcs = [];
  currentArcs = computeArcs();
  currentDirectSet = new Set();
  for (const a of currentArcs) { currentDirectSet.add(a.other); if (state.global) currentDirectSet.add(a.s); }
  currentOneStop = computeOneStop(currentArcs);
  currentReach = computeReach();
  currentOutCodes = new Set((routesFrom.get(state.origin) || []).map((r) => r.d));
  currentInCodes = new Set((routesTo.get(state.origin) || []).map((r) => r.s));
  document.querySelectorAll('[data-dir]').forEach((b) => {
    const labels = { out: `Departures ${currentOutCodes.size}`, in: `Arrivals ${currentInCodes.size}`, both: 'Both' };
    b.textContent = labels[b.dataset.dir];
  });
  globe.arcsData(currentArcs);
  globe.pointsData(DB.airports);
  globe.ringsData(state.global ? [] : [origin]);
  setupPlanes();

  const countries = new Set(currentArcs.map((a) => byIata.get(a.other)?.country).filter(Boolean));
  setOriginCard();
  els.legend.textContent = LEGENDS[state.colorMode] +
    (!state.global && state.dir !== 'both' ? ' Pink arcs are one-way in the data (no return route listed). Most routes are reciprocal, so Departures and Arrivals largely overlap.' : '') +
    (state.showOneStop && !state.global ? ' Violet dots are one-stop destinations — hover one to trace its connecting path.' : '') +
    (state.reachability && currentReach.size ? ' Reachability colours: cyan = nonstop, violet = 1 stop, orange = 2 stops, faint = not reachable within 2 stops.' : '');
  let reachStats = '';
  if (currentReach.size) {
    const counts = [0, 0, 0, 0];
    const reachCountries = new Set();
    for (const [code, lvl] of currentReach) {
      counts[lvl]++;
      if (lvl >= 1) reachCountries.add(byIata.get(code)?.country);
    }
    const reachable = counts[1] + counts[2] + counts[3];
    reachStats = ` · Reachable: ${counts[1]} nonstop, ${counts[2]} in 1 stop, ${counts[3]} in 2 stops` +
      ` — ${reachable} of ${DB.airports.length} airports (${Math.round((reachable / DB.airports.length) * 100)}%), ${reachCountries.size} countries`;
  }
  const outOnly = [...currentOutCodes].filter((c) => !currentInCodes.has(c));
  const inOnly = [...currentInCodes].filter((c) => !currentOutCodes.has(c));
  const dirInfo = state.global ? '' : state.dir === 'out'
    ? ` · Direction: ${currentOutCodes.size - outOnly.length} of ${currentOutCodes.size} also fly inbound${outOnly.length ? ` · outbound-only: ${outOnly.slice(0, 8).join(', ')}` : ' · no outbound-only routes'}`
    : state.dir === 'in'
      ? ` · Direction: ${currentInCodes.size - inOnly.length} of ${currentInCodes.size} also fly outbound${inOnly.length ? ` · inbound-only: ${inOnly.slice(0, 8).join(', ')}` : ' · no inbound-only routes'}`
      : ` · Direction: ${outOnly.length} outbound-only, ${inOnly.length} inbound-only, rest reciprocal`;
  els.status.textContent = state.global
    ? `Showing ${currentArcs.length} busiest routes · arc width = airlines per route`
    : `${origin.iata}: ${currentArcs.length} nonstop routes · ${countries.size} countries` +
      (currentOneStop.size ? ` · +${currentOneStop.size} one-stop via ${new Set([...currentOneStop.values()].map((i) => i.via)).size} hubs` : '') + reachStats + dirInfo;
  els.destTitle.textContent = state.global ? 'Busiest routes' : `${state.dir === 'in' ? 'Arriving from' : 'Destinations from'} ${origin.iata}`;
  ensureAbstract(origin);
  renderRouteCard();
  renderDestList();
  if (flyToOrigin && !state.global) {
    globe.pointOfView({ lat: origin.lat, lng: origin.lng, altitude: 1.9 }, 1100);
  }
}

function rowHTML(r, extraClass = '') {
  return `<li><button data-code="${r.code}" class="${extraClass}" title="${r.title || ''}">
    <span class="li-code">${r.code}</span>
    <span class="li-main">${r.label}<small>${r.sub}</small></span>
    <span class="li-meta">${r.km.toLocaleString()} km<br/><b>${r.meta}</b></span>
  </button></li>`;
}
function wireRows(listEl) {
  listEl.querySelectorAll('button').forEach((b) => {
    b.title = `${b.title ? b.title + ' · ' : ''}Click for route details, double-click to explore from here`;
    b.addEventListener('click', () => setSelected(b.dataset.code));
    b.addEventListener('dblclick', () => setOrigin(b.dataset.code, true));
    b.addEventListener('mouseenter', () => setHover(b.dataset.code));
    b.addEventListener('mouseleave', () => setHover(null));
  });
}
function applySort(rows, totalKmKey = 'km') {
  const sorters = {
    n: (a, b) => (b.score ?? b.n) - (a.score ?? a.n) || a.label.localeCompare(b.label),
    km: (a, b) => b[totalKmKey] - a[totalKmKey],
    near: (a, b) => a[totalKmKey] - b[totalKmKey],
    name: (a, b) => a.label.localeCompare(b.label),
  };
  rows.sort(sorters[state.sort]);
  return rows;
}
function renderDestList() {
  let rows;
  if (state.global) {
    rows = currentArcs.slice(0, 120).map((a) => ({
      code: a.d, label: `${a.s} → ${a.d}`, sub: byIata.get(a.d)?.city || '',
      n: a.n, score: a.n, km: a.km, meta: `${a.n} airline${a.n === 1 ? '' : 's'}`,
    }));
  } else {
    const best = new Map();
    for (const a of currentArcs) {
      const prev = best.get(a.other);
      if (!prev || a.n > prev.n) best.set(a.other, a);
    }
    rows = [...best.values()].map((a) => {
      const ap = byIata.get(a.other);
      const oneWayDir = state.dir === 'out' ? !currentInCodes.has(a.other)
        : state.dir === 'in' ? !currentOutCodes.has(a.other) : false;
      return {
        code: a.other, label: ap.city,
        sub: ap.country + (oneWayDir ? (state.dir === 'out' ? ' · outbound only' : ' · inbound only') : ''),
        n: a.n, score: a.n, km: a.km,
        title: a.airlineNames, meta: `${a.n} airline${a.n === 1 ? '' : 's'}${oneWayDir ? ' · one-way' : ''}`,
      };
    });
  }
  if (state.destQuery) {
    const q = state.destQuery.toLowerCase();
    rows = rows.filter((r) => `${r.code} ${r.label} ${r.sub}`.toLowerCase().includes(q));
  }
  els.destList.innerHTML = applySort(rows).slice(0, 400).map((r) => rowHTML(r)).join('') ||
    '<li class="empty">No routes match these filters. Lower the minimum-airline count or clear the airline filter.</li>';
  wireRows(els.destList);

  // one-stop section
  const showOS = state.showOneStop && !state.global && state.dir !== 'both';
  els.oneStopSection.hidden = !showOS;
  if (showOS) {
    let osRows = [...currentOneStop.values()].map((info) => {
      const ap = byIata.get(info.code);
      return {
        code: info.code, label: ap.city, sub: `${ap.country} · via ${info.via}`,
        score: info.score, km: info.km,
        title: `${state.origin} → ${info.via} → ${info.code} (${info.hubCount} hub option${info.hubCount === 1 ? '' : 's'})`,
        meta: `via ${info.via}`,
      };
    });
    if (state.destQuery) {
      const q = state.destQuery.toLowerCase();
      osRows = osRows.filter((r) => `${r.code} ${r.label} ${r.sub}`.toLowerCase().includes(q));
    }
    els.oneStopTitle.textContent =
      `${state.dir === 'in' ? 'One-stop origins' : 'One-stop destinations'} (${osRows.length}) — hover to trace path`;
    els.oneStopList.innerHTML = applySort(osRows).slice(0, 400).map((r) => rowHTML(r, 'onestop-row')).join('') ||
      '<li class="empty">No one-stop destinations under these filters.</li>';
    wireRows(els.oneStopList);
  }
}

/* ---------- events ---------- */
document.querySelectorAll('[data-dir]').forEach((btn) => btn.addEventListener('click', () => {
  document.querySelectorAll('[data-dir]').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on'); state.dir = btn.dataset.dir; buildAirlineOptions(); render();
}));
els.airline.addEventListener('change', () => { state.airline = els.airline.value; render(); });
els.minAirlines.addEventListener('input', () => { state.minN = +els.minAirlines.value; els.minAirlinesVal.textContent = state.minN; render(); });
els.maxKm.addEventListener('input', () => {
  state.maxKm = +els.maxKm.value;
  els.maxKmVal.textContent = state.maxKm >= 20000 ? 'Any' : `${state.maxKm.toLocaleString()} km`;
  render();
});
els.globalView.addEventListener('change', () => { state.global = els.globalView.checked; render(true); });
els.oneStop.addEventListener('change', () => { state.showOneStop = els.oneStop.checked; render(); });
els.reach.addEventListener('change', () => { state.reachability = els.reach.checked; render(); });
els.planes.addEventListener('change', setupPlanes);
els.dash.addEventListener('change', () => globe.arcsData(displayArcs()));
els.color.addEventListener('change', () => { state.colorMode = els.color.value; render(); });
els.earth.addEventListener('change', () => {
  sunUniforms.overrideMix.value = els.earth.value === 'day' ? 1 : els.earth.value === 'night' ? 0 : -1;
  if (els.earth.value === 'live') updateSun();
});
els.rotate.addEventListener('change', applyRotation);
els.destSort.addEventListener('change', () => { state.sort = els.destSort.value; renderDestList(); });
els.destSearch.addEventListener('input', () => { state.destQuery = els.destSearch.value.trim(); renderDestList(); });
/* ---------- origin autocomplete (code-first) ---------- */
let originMatches = [];
let originActive = -1;
function findAirports(query) {
  const q = query.trim().toLowerCase();
  if (!q) return DB.airports.slice(0, 10);
  const scored = [];
  for (const a of DB.airports) {
    const code = a.iata.toLowerCase();
    const city = a.city.toLowerCase();
    let score = -1;
    if (code === q) score = 0;
    else if (code.startsWith(q)) score = 1;
    else if (city.startsWith(q)) score = 2;
    else if (city.includes(q)) score = 3;
    else if (a.name.toLowerCase().includes(q) || a.country.toLowerCase().includes(q)) score = 4;
    if (score >= 0) scored.push({ a, score });
  }
  return scored.sort((x, y) => x.score - y.score || y.a.services - x.a.services).slice(0, 12).map((x) => x.a);
}
function renderOriginResults() {
  if (!DB) return;
  originMatches = findAirports(els.originSearch.value);
  originActive = originMatches.length ? 0 : -1;
  els.originResults.innerHTML = originMatches.length
    ? originMatches.map((a, i) => `
      <div role="option" data-code="${a.iata}" class="r-row ${i === originActive ? 'active' : ''}"><b>${a.iata}</b> · ${a.city} — ${a.name} · ${a.country}</div>`).join('')
    : '<div class="r-empty">No airport matches. Try a 3-letter code (TLV, JFK, LHR) or a city name.</div>';
  els.originResults.hidden = false;
  els.originSearch.setAttribute('aria-expanded', 'true');
}
function hideOriginResults() {
  els.originResults.hidden = true;
  els.originSearch.setAttribute('aria-expanded', 'false');
}
function chooseOrigin(code) {
  setOrigin(code, true);
  els.originSearch.value = '';
  hideOriginResults();
  els.originSearch.blur();
}
els.originResults.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-code]');
  if (b) { e.preventDefault(); chooseOrigin(b.dataset.code); }
});
els.originSearch.addEventListener('input', renderOriginResults);
els.originSearch.addEventListener('focus', renderOriginResults);
els.originSearch.addEventListener('blur', () => setTimeout(hideOriginResults, 150));
els.originSearch.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!originMatches.length) return;
    originActive = (originActive + (e.key === 'ArrowDown' ? 1 : -1) + originMatches.length) % originMatches.length;
    els.originResults.querySelectorAll('.r-row').forEach((b, i) => b.classList.toggle('active', i === originActive));
    els.originResults.querySelectorAll('.r-row')[originActive]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const exact = els.originSearch.value.trim().toUpperCase();
    if (byIata.has(exact)) chooseOrigin(exact);
    else if (originMatches.length) chooseOrigin(originMatches[Math.max(0, originActive)].iata);
  } else if (e.key === 'Escape') {
    hideOriginResults();
  }
});

/* ---------- trip planner target picker ---------- */
let targetMatches = [];
function renderTargetResults() {
  if (!DB) return;
  targetMatches = findAirports(els.targetSearch.value);
  els.targetResults.innerHTML = targetMatches.length
    ? targetMatches.map((a) => `
      <div role="option" data-code="${a.iata}" class="r-row"><b>${a.iata}</b> · ${a.city} — ${a.name} · ${a.country}</div>`).join('')
    : '<div class="r-empty">No airport matches. Try a 3-letter code or a city name.</div>';
  els.targetResults.hidden = false;
  els.targetSearch.setAttribute('aria-expanded', 'true');
}
function chooseTarget(code) {
  if (code === state.origin) return;
  const ap = byIata.get(code);
  els.targetSearch.value = `${code} — ${ap.city}`;
  els.targetResults.hidden = true;
  setSelected(code);
}
els.targetResults.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-code]');
  if (b) { e.preventDefault(); chooseTarget(b.dataset.code); }
});
els.targetSearch.addEventListener('input', renderTargetResults);
els.targetSearch.addEventListener('focus', renderTargetResults);
els.targetSearch.addEventListener('blur', () => setTimeout(() => { els.targetResults.hidden = true; }, 150));
els.targetSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const exact = els.targetSearch.value.trim().slice(0, 3).toUpperCase();
    if (byIata.has(exact)) chooseTarget(exact);
    else if (targetMatches.length) chooseTarget(targetMatches[0].iata);
  } else if (e.key === 'Escape') els.targetResults.hidden = true;
});

/* ---------- boot ---------- */
fetch('/data/atlas.json')
  .then((r) => { if (!r.ok) throw new Error(`data load failed (${r.status}) — run: pnpm data`); return r.json(); })
  .then((data) => {
    DB = data;
    byIata = new Map(DB.airports.map((a) => [a.iata, a]));
    indexRoutes(DB.routes);
    els.globalStats.textContent =
      `${DB.meta.airports.toLocaleString()} major airports · ${DB.meta.routes.toLocaleString()} nonstop routes · ${Object.keys(DB.airlines).length} airlines` +
      (DB.meta.wikipediaAbstracts ? ` · ${DB.meta.wikipediaAbstracts.toLocaleString()} Wikipedia abstracts` : '');
    if (!byIata.has(state.origin)) state.origin = DB.airports[0].iata;
    buildAirlineOptions();
    applyRotation();
    render(true);
  })
  .catch((err) => { els.globalStats.textContent = err.message; els.status.textContent = err.message; });
