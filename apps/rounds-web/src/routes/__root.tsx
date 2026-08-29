import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Rounds" },
    ],
  }),
  component: RootDocument,
});

/**
 * One stylesheet rather than inline styles per element, so states that matter on a ward — a
 * pending write, a selected bed, a reading that has not synced — can actually be expressed.
 */
const styles = `
  :root {
    color-scheme: light dark;
    --ground: #fbfbfa;
    --raised: #ffffff;
    --line: #e4e4e1;
    --ink: #1a1a18;
    --muted: #6b6b66;
    --accent: #2f5d50;
    --accent-ink: #ffffff;
    --warn-bg: #fdf0ee;
    --warn-line: #e8b4aa;
    --warn-ink: #8c2f1c;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #161615; --raised: #1e1e1c; --line: #33332f; --ink: #f2f2ee;
      --muted: #9a9a92; --accent: #7fb3a1; --accent-ink: #10201b;
      --warn-bg: #2c1a16; --warn-line: #5e3227; --warn-ink: #f0b3a4;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .page { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
  header h1 { font-size: 1.6rem; letter-spacing: -0.015em; margin: 0 0 0.25rem; }
  header p { margin: 0; color: var(--muted); }
  section {
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 1.25rem;
    margin-top: 1.5rem;
  }
  section h2 {
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 0 0 0.875rem; font-weight: 600;
  }
  .beds { display: flex; flex-wrap: wrap; gap: 0.5rem; list-style: none; margin: 0 0 1rem; padding: 0; }
  .bed {
    display: grid; gap: 0.1rem; text-align: left; cursor: pointer;
    background: var(--ground); color: inherit;
    border: 1px solid var(--line); border-radius: 8px; padding: 0.5rem 0.75rem; font: inherit;
  }
  .bed:hover { border-color: var(--accent); }
  .bed[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .bed strong { font-variant-numeric: tabular-nums; font-size: 0.9rem; }
  .bed span { font-size: 0.8rem; opacity: 0.75; }
  button.act {
    font: inherit; cursor: pointer; border-radius: 8px; padding: 0.45rem 0.9rem;
    border: 1px solid var(--line); background: var(--ground); color: inherit;
  }
  button.act:hover:not(:disabled) { border-color: var(--accent); }
  button.act:disabled { opacity: 0.5; cursor: default; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .readings { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: 0.5rem; }
  .reading {
    display: flex; align-items: baseline; gap: 0.6rem;
    border-bottom: 1px solid var(--line); padding-bottom: 0.5rem;
  }
  .reading:last-child { border-bottom: 0; }
  .code {
    font-size: 0.7rem; letter-spacing: 0.06em; color: var(--muted);
    border: 1px solid var(--line); border-radius: 5px; padding: 0.1rem 0.35rem;
  }
  .value { font-variant-numeric: tabular-nums; font-weight: 600; }
  .by { color: var(--muted); font-size: 0.85rem; margin-left: auto; }
  .amends { font-size: 0.75rem; color: var(--muted); font-style: italic; }
  .empty { color: var(--muted); margin: 0 0 1rem; }
  .problem {
    background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn-ink);
    border-radius: var(--radius); padding: 0.75rem 1rem; margin-top: 1.5rem;
  }
  .problem p { margin: 0.25rem 0 0; font-size: 0.85rem; opacity: 0.9; }
`;

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
