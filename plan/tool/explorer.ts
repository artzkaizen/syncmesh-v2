/**
 * The codebase as a map. `bun plan/tool/explorer.ts` → http://localhost:4500
 *
 * Districts are the architecture, buildings are modules (height = lines of
 * code, counted live from the files), flows are the stories — each step
 * anchored to the real file it makes a claim about, opening in Zed on click.
 *
 * The content is curated in ./explorer/data.ts, never generated; the prose
 * twin is plan/codebase-map.md. A step naming a missing file or an unknown
 * building refuses to start — definition mistakes throw (rule 4).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEPS, DISTRICTS, FLOWS } from "./explorer/data.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");

function lines(path: string): number {
  return readFileSync(join(ROOT, path), "utf8").split("\n").length;
}

// -- refuse to serve a map that lies -----------------------------------------
const codes = new Set<string>();
for (const d of DISTRICTS) {
  for (const b of d.buildings) {
    if (codes.has(b.code)) throw new Error(`building code ${b.code} declared twice`);
    codes.add(b.code);
    for (const f of b.files) statSync(join(ROOT, f)); // throws when the file is gone
  }
}
for (const flow of FLOWS) {
  for (const [i, step] of flow.steps.entries()) {
    if (!codes.has(step.b)) throw new Error(`${flow.slug} step ${i + 1}: no building ${step.b}`);
    if (step.f !== undefined) statSync(join(ROOT, step.f));
  }
  statSync(join(ROOT, flow.readMore));
}
const districtIds = new Set(DISTRICTS.map((d) => d.id));
for (const [a, b] of DEPS) {
  if (!districtIds.has(a) || !districtIds.has(b)) throw new Error(`unknown district in dep ${a}→${b}`);
}

// -- live numbers ------------------------------------------------------------
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
}

function stats() {
  const files: string[] = [];
  for (const group of ["packages", "adapters"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      const src = join(group, name, "src");
      try {
        statSync(join(ROOT, src));
      } catch {
        continue;
      }
      walk(src, files);
    }
  }
  const tests = files.filter((f) => f.includes("__tests__")).length;
  const source = files.filter((f) => !f.includes("__tests__"));
  const loc = source.reduce((n, f) => n + lines(f), 0);
  let done = 0;
  let total = 0;
  for (const f of readdirSync(join(ROOT, "plan", "epics"))) {
    if (!f.endsWith(".md")) continue;
    const text = readFileSync(join(ROOT, "plan", "epics", f), "utf8");
    done += (text.match(/^\s*- \[(x|X)\]/gm) ?? []).length;
    total += (text.match(/^\s*- \[( |x|X)\]/gm) ?? []).length;
  }
  return { files: source.length, loc, tests, done, total };
}

function payload() {
  const districts = DISTRICTS.map((d) => ({
    ...d,
    buildings: d.buildings.map((b) => ({
      ...b,
      loc: b.files.reduce((n, f) => n + lines(f), 0),
    })),
  }));
  return { root: ROOT, stats: stats(), districts, deps: DEPS, flows: FLOWS };
}

function page(): string {
  const data = JSON.stringify(payload()).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>syncmesh — explorer</title>
<style>
:root{--bg:#faf9f6;--panel:#ffffff;--fg:#1f1f1f;--mute:#8a857c;--line:#e6e2da;--soft:#f1eee8;
  --acc:#5b5bd6;--acc-soft:#e4e4fb;--warn:#b26b00;
  --face-top:#f3f1ec;--face-left:#e6e2d9;--face-right:#d8d3c8;--edge:#b6b0a4;--plate:#f5f3ee;--grid:#eceae4}
@media(prefers-color-scheme:dark){:root{--bg:#151412;--panel:#1c1b18;--fg:#e8e6e1;--mute:#8f8a80;--line:#2e2c27;--soft:#232119;
  --acc:#8f8fef;--acc-soft:#2c2c4a;
  --face-top:#2a2823;--face-left:#211f1b;--face-right:#191814;--edge:#454138;--plate:#1b1a16;--grid:#232119}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
code,.mono{font:11px ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
#app{display:grid;grid-template-rows:46px 1fr 26px;grid-template-columns:236px 1fr 300px;height:100vh}
header{grid-column:1/4;display:flex;align-items:center;gap:18px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel)}
header .brand{font-weight:700;letter-spacing:.02em}
header .brand span{color:var(--mute);font-weight:400;font-size:11px;margin-left:6px}
.stat{display:flex;flex-direction:column;line-height:1.15}
.stat b{font-size:12px;font-weight:600}
.stat i{font-style:normal;color:var(--mute);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em}
header .grow{flex:1}
button{font:inherit;color:var(--fg);background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:5px 10px;cursor:pointer}
button:hover{border-color:var(--mute)}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}
button.speed.on{background:var(--acc-soft);border-color:var(--acc);color:var(--acc)}
.legend{display:flex;gap:12px;color:var(--mute);font-size:10.5px;align-items:center}
.legend .sw{display:inline-block;width:16px;height:0;border-top:2px solid var(--acc);vertical-align:middle;margin-right:4px}
.legend .sw.dep{border-top:1px dashed var(--edge)}
.legend .sw.dot{width:7px;height:7px;border:0;border-radius:50%;background:var(--acc)}
aside{background:var(--panel);border-right:1px solid var(--line);overflow-y:auto;padding:10px 0}
aside h2{font-size:9.5px;letter-spacing:.09em;color:var(--mute);margin:14px 14px 6px;font-weight:600}
.item{padding:7px 14px;cursor:pointer;border-left:2px solid transparent}
.item:hover{background:var(--soft)}
.item.on{background:var(--acc-soft);border-left-color:var(--acc)}
.item .n{font-weight:600;font-size:12px}
.item .s{color:var(--mute);font-size:10.5px}.item.on .s{color:var(--acc)}
.item.dim .n{color:var(--mute);font-weight:500}
#canvas{position:relative;overflow:hidden;background:var(--bg)}
#scene{position:absolute;inset:0;width:100%;height:100%;cursor:grab}
#scene.panning{cursor:grabbing}
#caption{position:absolute;max-width:330px;background:var(--panel);border:1px solid var(--line);border-radius:7px;
  padding:8px 11px;box-shadow:0 6px 24px rgba(0,0,0,.12);font-size:12px;display:none;pointer-events:none;z-index:3}
#caption .k{color:var(--acc);font-weight:700;font-size:10.5px;letter-spacing:.03em}
#caption .payload{color:var(--mute);font-size:10px;margin-top:3px}
#tip{position:absolute;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 9px;
  font-size:11px;display:none;pointer-events:none;z-index:4;box-shadow:0 4px 14px rgba(0,0,0,.1)}
#tip .t{font-weight:600}#tip .m{color:var(--mute);font-size:10px}
#flowbar{position:absolute;top:10px;left:10px;display:none;gap:6px;align-items:center;z-index:2}
#flowbar .name{background:var(--acc-soft);color:var(--acc);border:1px solid var(--acc);border-radius:5px;
  padding:5px 10px;font-size:11px;font-weight:700;letter-spacing:.04em}
#right{background:var(--panel);border-left:1px solid var(--line);overflow-y:auto;padding:14px}
#right h1{font-size:16px;margin:2px 0 4px}
#right .payload{color:var(--mute);font-size:11px}
#right .summary{margin:10px 0 12px;color:var(--fg);font-size:12px}
#right h3{font-size:9.5px;letter-spacing:.09em;color:var(--mute);font-weight:600;margin:12px 0 6px}
.step{display:flex;gap:9px;padding:7px 8px;border-radius:6px;cursor:pointer;margin:1px 0}
.step:hover{background:var(--soft)}
.step.on{background:var(--acc-soft)}
.step.done .num{color:var(--acc)}
.step .num{color:var(--mute);font-size:11px;min-width:14px;text-align:right;padding-top:1px}
.step .where{font-size:9.5px;letter-spacing:.05em;color:var(--mute);font-weight:600}
.step.on .where{color:var(--acc)}
.step .t{font-size:11.5px;margin:2px 0}
.step .f{font-size:10px}
#right .more{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);font-size:11px}
#right .hint{color:var(--mute);font-size:12px;margin-top:16px}
footer{grid-column:1/4;display:flex;align-items:center;padding:0 14px;border-top:1px solid var(--line);
  background:var(--panel);color:var(--mute);font-size:9.5px;letter-spacing:.07em}
svg text{user-select:none}
.plate{fill:var(--plate);stroke:var(--line)}
.gridline{stroke:var(--grid);stroke-width:1}
.dep{stroke:var(--edge);stroke-width:1;stroke-dasharray:3 4;fill:none;opacity:.55}
.b .top{fill:var(--face-top);stroke:var(--edge);stroke-width:1}
.b .left{fill:var(--face-left);stroke:var(--edge);stroke-width:1}
.b .right{fill:var(--face-right);stroke:var(--edge);stroke-width:1}
.b.ghost .top,.b.ghost .left,.b.ghost .right{fill:none;stroke-dasharray:3 3}
.b .code{font:700 9px ui-monospace,Menlo,monospace;fill:var(--mute)}
.b.lit .top{fill:var(--acc-soft);stroke:var(--acc)}
.b.lit .code{fill:var(--acc)}
.b.now .left,.b.now .right{stroke:var(--acc)}
.dlabel rect{fill:var(--panel);stroke:var(--line);rx:3}
.dlabel text{font:600 9px ui-monospace,Menlo,monospace;fill:var(--mute);letter-spacing:.08em}
.trail{stroke:var(--acc);stroke-width:1.4;opacity:.35;fill:none}
.wire{stroke:var(--acc);stroke-width:2;fill:none}
.node{fill:var(--acc)}
.node.o{fill:var(--panel);stroke:var(--acc);stroke-width:1.6}
</style>
<div id="app">
<header>
  <div class="brand">syncmesh<span>EXPLORER</span></div>
  <div class="stat"><b id="st-flows"></b><i>flows</i></div>
  <div class="stat"><b id="st-files"></b><i>files</i></div>
  <div class="stat"><b id="st-loc"></b><i>lines of ts</i></div>
  <div class="stat"><b id="st-tests"></b><i>test files</i></div>
  <div class="stat"><b id="st-tasks"></b><i>plan tasks</i></div>
  <div class="grow"></div>
  <button id="play" class="primary">PLAY FLOW</button>
  <button id="onestep">STEP</button>
  <span>
    <button class="speed" data-s="0.5">.5×</button><button class="speed on" data-s="1">1×</button><button class="speed" data-s="2">2×</button>
  </span>
  <div class="legend"><span><span class="sw"></span>FLOW</span><span><span class="sw dep"></span>DEPENDENCY</span><span><span class="sw dot"></span>PAYLOAD</span></div>
</header>
<aside id="left"></aside>
<div id="canvas">
  <div id="flowbar"><span class="name" id="flowname"></span></div>
  <svg id="scene"><g id="world"></g></svg>
  <div id="caption"></div>
  <div id="tip"></div>
</div>
<div id="right"></div>
<footer>CHOOSE A FLOW &nbsp;·&nbsp; SPACE PLAYS &nbsp;·&nbsp; ← → STEP &nbsp;·&nbsp; HOVER A BLOCK &nbsp;·&nbsp; DRAG TO PAN &nbsp;·&nbsp; SCROLL TO ZOOM &nbsp;·&nbsp; 0 FITS &nbsp;·&nbsp; ESC CLEARS</footer>
</div>
<script>window.__SYNCMESH__ = ${data}</script>
<script src="/client.js"></script>`;
}

Bun.serve({
  port: 4500,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/client.js") {
      return new Response(Bun.file(join(import.meta.dir, "explorer", "client.js")), {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    }
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log("explorer → http://localhost:4500");
