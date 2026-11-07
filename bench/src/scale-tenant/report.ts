import type { TenantResults } from "./measure.js";

/** One run as a markdown table: a phase per row, the invariants beneath. */
export const markdown = (r: TenantResults): string => {
  const lines = [
    `### ${r.backend} — ${r.loaded.toLocaleString()} of ${r.target.toLocaleString()} rows, ${r.events.toLocaleString()} events, ${r.partitions} partitions (${r.runtime})`,
    "",
    "| phase | status | time | rss | peak rss | detail |",
    "|---|---|---|---|---|---|",
    ...r.phases.map(
      (p) =>
        `| ${p.name} | ${p.status} | ${(p.ms / 1000).toFixed(1)} s | ${p.rssMb} MB | ${p.peakRssMb} MB | ${Object.entries(
          p.detail,
        )
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")} |`,
    ),
    "",
    ...Object.entries(r.invariants).map(([name, held]) => `- ${held ? "✓" : "✗"} ${name}`),
  ];
  return lines.join("\n");
};
