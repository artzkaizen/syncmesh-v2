/**
 * The plan, as a page. `bun plan/tool/serve.ts` → http://localhost:4400
 *
 * Markdown is the source of truth. This reads plan/epics/*.md and
 * plan/decisions/*.md, draws the dependency graph, shows progress, and lets you
 * tick tasks — a tick rewrites the `- [ ]` in the file, so state lives in git.
 * It never decides anything: a decision is edited in its file, by you.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const EPICS = join(ROOT, "epics");
const DECISIONS = join(ROOT, "decisions");

type Task = { line: number; done: boolean; text: string; section: string };
type Epic = {
  file: string; id: string; title: string; phase: number; deps: string[];
  size: string; tasks: Task[]; sections: Record<string, string[]>;
};
type Decision = { file: string; id: string; title: string; status: string; decided: string; epics: string[]; sections: Record<string, string[]> };

function frontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: src.slice(m[0].length) };
}
const list = (v: string | undefined): string[] =>
  (v ?? "").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);

function sectionsOf(body: string, fmLines: number): { sections: Record<string, string[]>; tasks: Task[] } {
  const sections: Record<string, string[]> = {};
  const tasks: Task[] = [];
  let cur = "_";
  body.split("\n").forEach((raw, i) => {
    const h = raw.match(/^##\s+(.*)$/);
    if (h) { cur = h[1]!.trim(); sections[cur] ??= []; return; }
    const t = raw.match(/^\s*- \[( |x|X)\]\s+(.*)$/);
    if (t) { tasks.push({ line: i + fmLines, done: t[1] !== " ", text: t[2]!, section: cur }); return; }
    (sections[cur] ??= []).push(raw);
  });
  return { sections, tasks };
}

function loadEpics(): Epic[] {
  return readdirSync(EPICS).filter((f) => f.endsWith(".md")).sort().map((file) => {
    const src = readFileSync(join(EPICS, file), "utf8");
    const { meta, body } = frontmatter(src);
    const fmLines = src.length - body.length === 0 ? 0 : src.slice(0, src.length - body.length).split("\n").length - 1;
    const { sections, tasks } = sectionsOf(body, fmLines);
    return {
      file, id: meta.id ?? file.replace(/\.md$/, ""), title: meta.title ?? file,
      phase: Number(meta.phase ?? 0), deps: list(meta.deps), size: meta.size ?? "",
      tasks, sections,
    };
  });
}
function loadDecisions(): Decision[] {
  return readdirSync(DECISIONS).filter((f) => f.endsWith(".md")).sort().map((file) => {
    const src = readFileSync(join(DECISIONS, file), "utf8");
    const { meta, body } = frontmatter(src);
    const { sections } = sectionsOf(body, 0);
    return {
      file, id: meta.id ?? file, title: meta.title ?? file, status: meta.status ?? "open",
      decided: meta.decided ?? "", epics: list(meta.epics), sections,
    };
  });
}

function toggle(file: string, line: number): void {
  const path = join(EPICS, file);
  const lines = readFileSync(path, "utf8").split("\n");
  const l = lines[line] ?? "";
  if (/^\s*- \[ \]/.test(l)) lines[line] = l.replace("- [ ]", "- [x]");
  else if (/^\s*- \[(x|X)\]/.test(l)) lines[line] = l.replace(/- \[(x|X)\]/, "- [ ]");
  writeFileSync(path, lines.join("\n"));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const md = (lines: string[]) => {
  // deliberately tiny: paragraphs, bullets, inline code. the files stay readable raw.
  const out: string[] = []; let inList = false;
  for (const raw of lines) {
    const l = raw.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    if (/^\s*- /.test(raw)) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${l.replace(/^\s*- /, "")}</li>`); continue; }
    if (inList) { out.push("</ul>"); inList = false; }
    if (raw.trim() === "") continue;
    if (/^\|/.test(raw)) { out.push(`<div class="row">${l}</div>`); continue; }
    out.push(`<p>${l}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
};

function graphSvg(epics: Epic[]): string {
  const phases = [...new Set(epics.map((e) => e.phase))].sort((a, b) => a - b);
  const col = new Map(phases.map((p, i) => [p, i]));
  const byPhase = new Map<number, Epic[]>();
  for (const e of epics) (byPhase.get(e.phase) ?? byPhase.set(e.phase, []).get(e.phase)!).push(e);
  const W = 190, H = 46, GX = 70, GY = 14, PAD = 20;
  const pos = new Map<string, { x: number; y: number }>();
  let maxRows = 0;
  for (const [p, list] of byPhase) {
    list.forEach((e, r) => pos.set(e.id, { x: PAD + col.get(p)! * (W + GX), y: PAD + r * (H + GY) }));
    maxRows = Math.max(maxRows, list.length);
  }
  const width = PAD * 2 + phases.length * (W + GX) - GX, height = PAD * 2 + maxRows * (H + GY) - GY;
  const edges = epics.flatMap((e) => e.deps.map((d) => {
    const a = pos.get(d), b = pos.get(e.id); if (!a || !b) return "";
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
    return `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" class="edge"/>`;
  }));
  const nodes = epics.map((e) => {
    const p = pos.get(e.id)!, done = e.tasks.filter((t) => t.done).length, n = e.tasks.length;
    const pct = n === 0 ? 0 : done / n;
    return `<g class="node ${pct === 1 ? "done" : pct > 0 ? "active" : ""}" onclick="location.hash='${e.id}'">
      <rect x="${p.x}" y="${p.y}" width="${W}" height="${H}" rx="4"/>
      <rect x="${p.x}" y="${p.y + H - 3}" width="${W * pct}" height="3" class="bar"/>
      <text x="${p.x + 10}" y="${p.y + 19}" class="id">${esc(e.id)}</text>
      <text x="${p.x + 10}" y="${p.y + 36}" class="t">${esc(e.title.slice(0, 28))}</text>
      <text x="${p.x + W - 10}" y="${p.y + 19}" class="n" text-anchor="end">${done}/${n}</text></g>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${edges.join("")}${nodes.join("")}</svg>`;
}

function page(): string {
  const epics = loadEpics(), decisions = loadDecisions();
  const total = epics.reduce((n, e) => n + e.tasks.length, 0), done = epics.reduce((n, e) => n + e.tasks.filter((t) => t.done).length, 0);
  const open = decisions.filter((d) => d.status !== "decided");
  const epicHtml = epics.map((e) => {
    const d = e.tasks.filter((t) => t.done).length, n = e.tasks.length;
    const dec = decisions.filter((x) => x.epics.includes(e.id));
    const tasksBySection = new Map<string, Task[]>();
    for (const t of e.tasks) (tasksBySection.get(t.section) ?? tasksBySection.set(t.section, []).get(t.section)!).push(t);
    const order = ["Goal", "Depends on", "Decisions needed", "Tasks", "Watch out", "Tests", "Done when"];
    const secs = [...new Set([...order.filter((s) => e.sections[s] || tasksBySection.has(s)), ...Object.keys(e.sections).filter((s) => s !== "_")])];
    return `<section class="epic" id="${e.id}">
      <header><span class="id">${esc(e.id)}</span><h2>${esc(e.title)}</h2>
        <span class="meta">phase ${e.phase}${e.size ? " · " + esc(e.size) : ""} · ${d}/${n}${e.deps.length ? " · after " + e.deps.map((x) => `<a href="#${x}">${esc(x)}</a>`).join(", ") : ""}</span>
        <span class="bar"><i style="width:${n ? (100 * d) / n : 0}%"></i></span></header>
      ${dec.length ? `<div class="decs">${dec.map((x) => `<a href="#${x.id}" class="dec ${x.status}">${esc(x.id)} ${x.status === "decided" ? "✓" : "open"}</a>`).join("")}</div>` : ""}
      ${secs.map((s) => {
        const body = e.sections[s] ? md(e.sections[s]!) : "";
        const ts = tasksBySection.get(s) ?? [];
        const tl = ts.length ? `<ul class="tasks">${ts.map((t) => `<li class="${t.done ? "done" : ""}"><label><input type="checkbox" ${t.done ? "checked" : ""} data-file="${esc(e.file)}" data-line="${t.line}"> <span>${esc(t.text).replace(/`([^`]+)`/g, "<code>$1</code>")}</span></label></li>`).join("")}</ul>` : "";
        return `<div class="sec ${s.toLowerCase().replace(/\s+/g, "-")}"><h3>${esc(s)}</h3>${body}${tl}</div>`;
      }).join("")}
    </section>`;
  }).join("");
  const decHtml = decisions.map((x) => `<section class="decision ${x.status}" id="${x.id}">
      <header><span class="id">${esc(x.id)}</span><h2>${esc(x.title)}</h2><span class="status">${x.status === "decided" ? "decided — " + esc(x.decided) : "open"}</span></header>
      ${Object.entries(x.sections).filter(([k]) => k !== "_").map(([k, v]) => `<div class="sec"><h3>${esc(k)}</h3>${md(v)}</div>`).join("")}
      <p class="edit">to decide: set <code>status: decided</code> and <code>decided: &lt;option&gt;</code> in <code>plan/decisions/${esc(x.file)}</code></p>
    </section>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>syncmesh — plan</title>
<style>
:root{--bg:#fafafa;--fg:#1f1f1f;--mute:#6b6b6b;--line:#e3e3e3;--acc:#2f6fed;--ok:#2a9d5c;--warn:#b26b00;--code:#f0f0f0}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e6e6e6;--mute:#9a9a9a;--line:#2b2b2b;--acc:#7aa2ff;--ok:#5ccc8a;--warn:#e0a040;--code:#222}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:3px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.top{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 24px;display:flex;gap:24px;align-items:center;z-index:2}
.top b{font-weight:600}.top .bar{flex:1;max-width:320px}
.bar{display:inline-block;height:4px;background:var(--line);border-radius:2px;overflow:hidden;vertical-align:middle;width:120px}.bar i{display:block;height:100%;background:var(--ok)}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:15px;font-weight:600;margin:32px 0 12px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.graph{overflow:auto;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
svg .node rect{fill:var(--bg);stroke:var(--line);cursor:pointer}svg .node.active rect{stroke:var(--acc)}svg .node.done rect{stroke:var(--ok)}
svg .node .bar{fill:var(--ok);stroke:none}svg .node text{font:12px ui-monospace,Menlo,monospace;fill:var(--fg)}svg .node .t{fill:var(--mute);font-family:ui-sans-serif,system-ui}svg .node .n{fill:var(--mute)}
svg .edge{fill:none;stroke:var(--line);stroke-width:1.2}
section{border:1px solid var(--line);border-radius:6px;padding:16px 20px;margin:12px 0}
section header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}section h2{font-size:16px;margin:0;font-weight:600}
.id{font:12px ui-monospace,Menlo,monospace;color:var(--mute)}.meta,.status{color:var(--mute);font-size:12.5px}
.decs{margin:8px 0}.dec{font:12px ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:3px;padding:1px 6px;margin-right:6px;color:var(--warn)}.dec.decided{color:var(--ok)}
.sec{margin-top:12px}.sec h3{font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0 0 4px;font-weight:600}
.sec p{margin:4px 0}.sec ul{margin:4px 0;padding-left:20px}
.watch-out{border-left:3px solid var(--warn);padding-left:12px}.done-when{border-left:3px solid var(--ok);padding-left:12px}
ul.tasks{list-style:none;padding:0}ul.tasks li{margin:3px 0}ul.tasks li.done span{color:var(--mute);text-decoration:line-through}ul.tasks label{cursor:pointer;display:flex;gap:8px;align-items:baseline}
.decision.open header .status{color:var(--warn)}.decision.decided header .status{color:var(--ok)}.edit{color:var(--mute);font-size:12px}
.row{font:12.5px ui-monospace,Menlo,monospace;white-space:pre;color:var(--mute)}
</style>
<div class="top"><b>syncmesh — plan</b><span class="bar"><i style="width:${total ? (100 * done) / total : 0}%"></i></span><span class="meta">${done}/${total} tasks · ${epics.length} epics · ${open.length} open decision${open.length === 1 ? "" : "s"}</span>
<a href="#decisions">decisions</a><a href="#epics">epics</a></div>
<main>
<h1>Dependency graph — columns are phases; click a node</h1><div class="graph">${graphSvg(epics)}</div>
<h1 id="decisions">Decisions — ${open.length} open. Nothing below is decided until its file says so.</h1>${decHtml}
<h1 id="epics">Epics</h1>${epicHtml}
</main>
<script>
document.addEventListener("change", async (ev) => {
  const el = ev.target; if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") return;
  const r = await fetch("/toggle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file: el.dataset.file, line: Number(el.dataset.line) }) });
  if (r.ok) location.reload(); else el.checked = !el.checked;
});
</script>`;
}

Bun.serve({
  port: 4400,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/toggle" && req.method === "POST") {
      const { file, line } = (await req.json()) as { file: string; line: number };
      if (!/^[\w.-]+\.md$/.test(file)) return new Response("bad file", { status: 400 });
      toggle(file, line);
      return new Response("ok");
    }
    if (url.pathname === "/api") return Response.json({ epics: loadEpics(), decisions: loadDecisions() });
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});
console.log("plan → http://localhost:4400");
