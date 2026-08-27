/* The explorer's renderer: an isometric city in one SVG, a playback engine
 * over the flows, pan/zoom, and the three panels. Plain JS, served as-is by
 * explorer.ts; the data arrives on window.__SYNCMESH__. */
"use strict";

const DATA = window.__SYNCMESH__;
const NS = "http://www.w3.org/2000/svg";
const TW = 46; // half tile width  (screen px per grid step, x)
const TH = 23; // half tile height (screen px per grid step, y)
const SIZE = 2; // building footprint in tiles
const STEP_MS = 2600;

const svg = document.getElementById("scene");
const world = document.getElementById("world");
const captionEl = document.getElementById("caption");
const tipEl = document.getElementById("tip");

const iso = (gx, gy) => [(gx - gy) * TW, (gx + gy) * TH];
const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(" ");

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  if (parent) parent.appendChild(node);
  return node;
}

// ---------------------------------------------------------------- model
const buildings = new Map();
for (const d of DATA.districts) {
  d.buildings.forEach((b, i) => {
    b.district = d;
    b.gx = d.gx + (i % d.cols) * 4;
    b.gy = d.gy + Math.floor(i / d.cols) * 4;
    b.h = b.virtual ? 26 : Math.max(18, Math.min(88, 10 + Math.sqrt(b.loc || 60) * 2.8));
    buildings.set(b.code, b);
  });
  const xs = d.buildings.map((b) => b.gx);
  const ys = d.buildings.map((b) => b.gy);
  d.min = [Math.min(...xs) - 1.2, Math.min(...ys) - 1.2];
  d.max = [Math.max(...xs) + SIZE + 1.2, Math.max(...ys) + SIZE + 1.2];
}
const topCenter = (b) => {
  const [x, y] = iso(b.gx + SIZE / 2, b.gy + SIZE / 2);
  return [x, y - b.h];
};

// ---------------------------------------------------------------- scene
const layers = {};
for (const name of ["plates", "grid", "deps", "city", "flow"])
  layers[name] = el("g", { class: name }, world);

(function drawGround() {
  let lo = [Infinity, Infinity];
  let hi = [-Infinity, -Infinity];
  for (const d of DATA.districts) {
    lo = [Math.min(lo[0], d.min[0]), Math.min(lo[1], d.min[1])];
    hi = [Math.max(hi[0], d.max[0]), Math.max(hi[1], d.max[1])];
  }
  lo = [Math.floor(lo[0]) - 4, Math.floor(lo[1]) - 4];
  hi = [Math.ceil(hi[0]) + 4, Math.ceil(hi[1]) + 4];
  for (let gx = lo[0]; gx <= hi[0]; gx += 2) {
    const [x1, y1] = iso(gx, lo[1]);
    const [x2, y2] = iso(gx, hi[1]);
    el("line", { class: "gridline", x1, y1, x2, y2 }, layers.grid);
  }
  for (let gy = lo[1]; gy <= hi[1]; gy += 2) {
    const [x1, y1] = iso(lo[0], gy);
    const [x2, y2] = iso(hi[0], gy);
    el("line", { class: "gridline", x1, y1, x2, y2 }, layers.grid);
  }
})();

for (const d of DATA.districts) {
  const corners = [
    iso(d.min[0], d.min[1]),
    iso(d.max[0], d.min[1]),
    iso(d.max[0], d.max[1]),
    iso(d.min[0], d.max[1]),
  ];
  el("polygon", { class: "plate", points: pts(corners) }, layers.plates);
  const [lx, ly] = iso((d.min[0] + d.max[0]) / 2, d.min[1]);
  const label = el("g", { class: "dlabel" }, layers.plates);
  const rect = el("rect", { x: 0, y: 0, height: 16, rx: 3 }, label);
  const text = el("text", { x: 0, y: 11.5, "text-anchor": "middle" }, label);
  text.textContent = d.name;
  requestAnimationFrame(() => {
    const w = text.getComputedTextLength() + 16;
    rect.setAttribute("width", w);
    rect.setAttribute("x", -w / 2);
    label.setAttribute("transform", `translate(${lx},${ly - 26})`);
  });
  d.center = iso((d.min[0] + d.max[0]) / 2, (d.min[1] + d.max[1]) / 2);
}

for (const [a, b] of DATA.deps) {
  const da = DATA.districts.find((d) => d.id === a);
  const db = DATA.districts.find((d) => d.id === b);
  el(
    "line",
    { class: "dep", x1: da.center[0], y1: da.center[1], x2: db.center[0], y2: db.center[1] },
    layers.deps,
  );
}

const sorted = [...buildings.values()].sort((a, b) => a.gx + a.gy - (b.gx + b.gy));
for (const b of sorted) {
  const g = el("g", { class: `b${b.ghost ? " ghost" : ""}`, "data-code": b.code }, layers.city);
  b.el = g;
  const { gx, gy, h } = b;
  const p00 = iso(gx, gy);
  const p10 = iso(gx + SIZE, gy);
  const p11 = iso(gx + SIZE, gy + SIZE);
  const p01 = iso(gx, gy + SIZE);
  const up = ([x, y]) => [x, y - h];
  el("polygon", { class: "left", points: pts([up(p01), up(p11), p11, p01]) }, g);
  el("polygon", { class: "right", points: pts([up(p10), up(p11), p11, p10]) }, g);
  el("polygon", { class: "top", points: pts([up(p00), up(p10), up(p11), up(p01)]) }, g);
  const [cx, cy] = topCenter(b);
  const code = el("text", { class: "code", x: cx, y: cy + 3, "text-anchor": "middle" }, g);
  code.textContent = b.code;
  g.addEventListener("mouseenter", () => showTip(b));
  g.addEventListener("mouseleave", hideTip);
}

function showTip(b) {
  const [wx, wy] = topCenter(b);
  const [sx, sy] = toScreen(wx, wy);
  const meta = b.virtual
    ? b.ghost
      ? "planned — not built yet"
      : "outside the repo"
    : `${b.files.length} file${b.files.length === 1 ? "" : "s"} · ${b.loc} lines`;
  tipEl.innerHTML = `<div class="t">${b.code} · ${esc(b.name)}</div><div class="m">${esc(b.district.name)} · ${meta}</div>`;
  tipEl.style.display = "block";
  tipEl.style.left = `${sx + 14}px`;
  tipEl.style.top = `${sy - 40}px`;
}
function hideTip() {
  tipEl.style.display = "none";
}
function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

// ---------------------------------------------------------------- camera
const view = { x: 0, y: 0, k: 1 };
function applyView() {
  world.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  placeCaption();
}
const toScreen = (wx, wy) => [wx * view.k + view.x, wy * view.k + view.y];

function fit(bounds) {
  const rect = svg.getBoundingClientRect();
  const box = bounds ?? world.getBBox();
  const pad = 46;
  view.k = Math.min(
    (rect.width - pad * 2) / box.width,
    (rect.height - pad * 2) / box.height,
    1.6,
  );
  view.x = (rect.width - box.width * view.k) / 2 - box.x * view.k;
  view.y = (rect.height - box.height * view.k) / 2 - box.y * view.k;
  applyView();
}

let pan = null;
svg.addEventListener("pointerdown", (ev) => {
  pan = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  svg.classList.add("panning");
  svg.setPointerCapture(ev.pointerId);
});
svg.addEventListener("pointermove", (ev) => {
  if (!pan) return;
  view.x = pan.vx + ev.clientX - pan.x;
  view.y = pan.vy + ev.clientY - pan.y;
  applyView();
});
svg.addEventListener("pointerup", () => {
  pan = null;
  svg.classList.remove("panning");
});
svg.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const next = Math.min(3, Math.max(0.25, view.k * Math.exp(-ev.deltaY * 0.0016)));
    view.x = mx - ((mx - view.x) / view.k) * next;
    view.y = my - ((my - view.y) / view.k) * next;
    view.k = next;
    applyView();
  },
  { passive: false },
);

// ---------------------------------------------------------------- playback
const state = { flow: null, idx: -1, playing: false, speed: 1, timer: null };
const playBtn = document.getElementById("play");
const flowbar = document.getElementById("flowbar");
const zed = (file) => `zed://file${DATA.root}/${file}`;

function clearOverlay() {
  layers.flow.replaceChildren();
  captionEl.style.display = "none";
  for (const b of buildings.values()) b.el.classList.remove("lit", "now");
}

function selectFlow(slug, autoplay) {
  stopTimer();
  state.flow = DATA.flows.find((f) => f.slug === slug) ?? null;
  state.idx = -1;
  clearOverlay();
  renderLeft();
  renderRight();
  flowbar.style.display = state.flow ? "flex" : "none";
  if (state.flow) {
    document.getElementById("flowname").textContent = `FLOW: ${state.flow.name.toUpperCase()}`;
    location.hash = `f=${slug}`;
    if (autoplay) play();
  } else {
    history.replaceState(null, "", location.pathname);
    playBtn.textContent = "PLAY FLOW";
  }
}

function stopTimer() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.playing = false;
  playBtn.textContent = state.flow && state.idx >= 0 ? "RESUME FLOW" : "PLAY FLOW";
}

function play() {
  if (!state.flow) return;
  if (state.idx >= state.flow.steps.length - 1) state.idx = -1;
  state.playing = true;
  playBtn.textContent = "PAUSE FLOW";
  advance();
}

function advance() {
  if (!state.playing) return;
  if (state.idx >= state.flow.steps.length - 1) {
    stopTimer();
    playBtn.textContent = "REPLAY FLOW";
    return;
  }
  stepTo(state.idx + 1);
  state.timer = setTimeout(advance, STEP_MS / state.speed);
}

function stepTo(idx) {
  if (!state.flow) return;
  state.idx = Math.max(0, Math.min(idx, state.flow.steps.length - 1));
  drawSteps();
  renderRight();
}

function drawSteps() {
  layers.flow.replaceChildren();
  for (const b of buildings.values()) b.el.classList.remove("lit", "now");
  const steps = state.flow.steps;
  let prev = null;
  for (let i = 0; i <= state.idx; i += 1) {
    const b = buildings.get(steps[i].b);
    b.el.classList.add("lit");
    const [cx, cy] = topCenter(b);
    const active = i === state.idx;
    if (prev && prev !== b) {
      const [px, py] = topCenter(prev);
      const line = el(
        "line",
        { class: active ? "wire" : "trail", x1: px, y1: py, x2: cx, y2: cy },
        layers.flow,
      );
      if (active) animateWire(line, [px, py], [cx, cy]);
    }
    el("circle", { class: `node${i === 0 ? " o" : ""}`, cx, cy, r: active ? 4.5 : 3 }, layers.flow);
    prev = b;
  }
  const now = buildings.get(steps[state.idx].b);
  now.el.classList.add("now");
  showCaption(now);
}

function animateWire(line, from, to) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  line.setAttribute("stroke-dasharray", len);
  line.setAttribute("stroke-dashoffset", len);
  const dot = el("circle", { class: "node", r: 3.5, cx: from[0], cy: from[1] }, layers.flow);
  const t0 = performance.now();
  const dur = Math.min(1100, 500 + len * 0.6) / state.speed;
  (function tick(t) {
    const p = Math.min(1, (t - t0) / dur);
    const ease = 1 - (1 - p) * (1 - p);
    line.setAttribute("stroke-dashoffset", len * (1 - ease));
    dot.setAttribute("cx", from[0] + (to[0] - from[0]) * ease);
    dot.setAttribute("cy", from[1] + (to[1] - from[1]) * ease);
    if (p < 1 && dot.isConnected) requestAnimationFrame(tick);
  })(t0);
}

let captionAnchor = null;
function showCaption(b) {
  const step = state.flow.steps[state.idx];
  captionAnchor = b;
  captionEl.innerHTML =
    `<span class="k">${state.idx + 1}/${state.flow.steps.length} · ${b.code}</span> &nbsp;${esc(step.t)}` +
    (step.f ? `<div class="payload mono">${esc(step.f)}</div>` : "");
  captionEl.style.display = "block";
  placeCaption();
}
function placeCaption() {
  if (!captionAnchor || captionEl.style.display === "none") return;
  const [wx, wy] = topCenter(captionAnchor);
  const [sx, sy] = toScreen(wx, wy);
  const rect = svg.getBoundingClientRect();
  captionEl.style.left = `${Math.max(8, Math.min(rect.width - 340, sx + 18))}px`;
  captionEl.style.top = `${Math.max(8, Math.min(rect.height - 90, sy + 16))}px`;
}

// ---------------------------------------------------------------- panels
function renderLeft() {
  const left = document.getElementById("left");
  const flowItems = DATA.flows
    .map(
      (f) => `<div class="item${state.flow && state.flow.slug === f.slug ? " on" : ""}" data-flow="${f.slug}">
        <div class="n">${esc(f.name)}</div><div class="s mono">${esc(f.payload)}</div></div>`,
    )
    .join("");
  const districtItems = DATA.districts
    .map(
      (d) => `<div class="item dim" data-district="${d.id}">
        <div class="n">${esc(d.name)}</div><div class="s">${d.buildings.length} blocks</div></div>`,
    )
    .join("");
  left.innerHTML = `<h2>FLOWS</h2>${flowItems}<h2>DISTRICTS</h2>${districtItems}`;
  for (const item of left.querySelectorAll("[data-flow]"))
    item.addEventListener("click", () => selectFlow(item.dataset.flow, true));
  for (const item of left.querySelectorAll("[data-district]"))
    item.addEventListener("click", () => {
      const d = DATA.districts.find((x) => x.id === item.dataset.district);
      const [x1, y1] = iso(d.min[0], d.min[1]);
      const [x2, y2] = iso(d.max[0], d.max[1]);
      const [x3] = iso(d.max[0], d.min[1]);
      const [x4] = iso(d.min[0], d.max[1]);
      const minX = Math.min(x1, x2, x3, x4) - 60;
      const maxX = Math.max(x1, x2, x3, x4) + 60;
      fit({ x: minX, y: y1 - 140, width: maxX - minX, height: y2 - y1 + 220 });
    });
}

function renderRight() {
  const right = document.getElementById("right");
  if (!state.flow) {
    right.innerHTML = `<h1>The codebase, as a map</h1>
      <div class="summary">Districts are the architecture, blocks are modules — height is lines of code, counted live. Pick a flow on the left to watch a story play across the city, each step anchored to the file that does it.</div>
      <div class="hint">The prose twin is <span class="mono">plan/codebase-map.md</span>. Blocks drawn dashed are planned, not built.</div>`;
    return;
  }
  const f = state.flow;
  const steps = f.steps
    .map((s, i) => {
      const b = buildings.get(s.b);
      const cls = i === state.idx ? " on" : i < state.idx ? " done" : "";
      return `<div class="step${cls}" data-i="${i}">
        <div class="num">${i + 1}</div>
        <div>
          <div class="where">${b.code} · ${esc(b.district.name)}</div>
          <div class="t">${esc(s.t)}</div>
          ${s.f ? `<a class="f mono" href="${zed(s.f)}">${esc(s.f)}</a>` : ""}
        </div></div>`;
    })
    .join("");
  right.innerHTML = `<h1>${esc(f.name)}</h1>
    <div class="payload mono">${f.steps.length} steps · payload: ${esc(f.payload)}</div>
    <div class="summary">${esc(f.summary)}</div>
    <h3>STEPS</h3>${steps}
    <div class="more">READ MORE &nbsp;<a class="mono" href="${zed(f.readMore)}">${esc(f.readMore)}</a></div>`;
  for (const node of right.querySelectorAll(".step"))
    node.addEventListener("click", (ev) => {
      if (ev.target.closest("a")) return;
      stopTimer();
      stepTo(Number(node.dataset.i));
    });
  const on = right.querySelector(".step.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- chrome
document.getElementById("st-flows").textContent = DATA.flows.length;
document.getElementById("st-files").textContent = DATA.stats.files;
document.getElementById("st-loc").textContent = DATA.stats.loc.toLocaleString();
document.getElementById("st-tests").textContent = DATA.stats.tests;
document.getElementById("st-tasks").textContent = `${DATA.stats.done}/${DATA.stats.total}`;

playBtn.addEventListener("click", () => (state.playing ? stopTimer() : play()));
document.getElementById("onestep").addEventListener("click", () => {
  if (!state.flow) selectFlow(DATA.flows[0].slug, false);
  stopTimer();
  stepTo(state.idx + 1);
});
for (const btn of document.querySelectorAll(".speed"))
  btn.addEventListener("click", () => {
    state.speed = Number(btn.dataset.s);
    for (const other of document.querySelectorAll(".speed")) other.classList.toggle("on", other === btn);
  });

document.addEventListener("keydown", (ev) => {
  if (ev.target.closest("input,textarea")) return;
  if (ev.key === " ") {
    ev.preventDefault();
    if (!state.flow) selectFlow(DATA.flows[0].slug, true);
    else if (state.playing) stopTimer();
    else play();
  } else if (ev.key === "ArrowRight") {
    stopTimer();
    stepTo(state.idx + 1);
  } else if (ev.key === "ArrowLeft") {
    stopTimer();
    stepTo(state.idx - 1);
  } else if (ev.key === "0") fit();
  else if (ev.key === "Escape") selectFlow(null, false);
});

window.addEventListener("resize", placeCaption);

// ---------------------------------------------------------------- boot
renderLeft();
renderRight();
requestAnimationFrame(() => {
  fit();
  const match = /f=([a-z-]+)/.exec(location.hash);
  if (match) selectFlow(match[1], true);
});
