/**
 * The words the seed builds a workspace out of.
 *
 * Kept apart from `seed.ts` because they are data and it is a program, and because the thing a
 * person actually wants to edit — "make the titles sound like my product" — should not mean
 * reading a loop. Titles are assembled from four banks rather than listed, so a hundred issues
 * are a hundred different sentences without a hundred lines of prose.
 */

export const TEAMS = [
  { key: "ENG", name: "Engineering", color: "#5E6AD2" },
  { key: "DES", name: "Design", color: "#E5484D" },
  { key: "OPS", name: "Operations", color: "#30A46C" },
] as const;

export const PEOPLE = [
  { name: "Ada Okonkwo", handle: "ada", color: "#5E6AD2" },
  { name: "Bo Lindqvist", handle: "bo", color: "#E5484D" },
  { name: "Chidi Eze", handle: "chidi", color: "#30A46C" },
  { name: "Dalia Haddad", handle: "dalia", color: "#F76808" },
  { name: "Emre Yilmaz", handle: "emre", color: "#8E4EC6" },
  { name: "Fen Zhao", handle: "fen", color: "#0091FF" },
  { name: "Greta Halvorsen", handle: "greta", color: "#FFB224" },
  { name: "Hana Ito", handle: "hana", color: "#D6409F" },
  { name: "Iker Mendoza", handle: "iker", color: "#12A594" },
  { name: "Juno Park", handle: "juno", color: "#946800" },
  { name: "Kwame Boateng", handle: "kwame", color: "#AB4ABA" },
  { name: "Lena Fischer", handle: "lena", color: "#3E63DD" },
] as const;

export const LABELS = [
  { name: "bug", color: "#E5484D", team: null },
  { name: "feature", color: "#5E6AD2", team: null },
  { name: "chore", color: "#8B8D98", team: null },
  { name: "regression", color: "#F76808", team: null },
  { name: "needs-design", color: "#D6409F", team: "DES" },
  { name: "a11y", color: "#12A594", team: "DES" },
  { name: "performance", color: "#FFB224", team: "ENG" },
  { name: "flaky", color: "#946800", team: "ENG" },
  { name: "on-call", color: "#0091FF", team: "OPS" },
  { name: "cost", color: "#30A46C", team: "OPS" },
] as const;

export const PROJECTS = [
  { team: "ENG", name: "Offline-first sync", status: "started" },
  { team: "ENG", name: "Query engine rewrite", status: "planned" },
  { team: "DES", name: "Design system 2.0", status: "started" },
  { team: "DES", name: "Onboarding refresh", status: "paused" },
  { team: "OPS", name: "Relay fleet in eu-west", status: "started" },
  { team: "OPS", name: "Cost review Q3", status: "completed" },
] as const;

export const ACTIONS = [
  "Fix",
  "Refactor",
  "Investigate",
  "Document",
  "Speed up",
  "Simplify",
  "Harden",
  "Instrument",
  "Redesign",
  "Roll out",
  "Deprecate",
  "Audit",
] as const;

export const THINGS = [
  "the presence heartbeat",
  "the board drag handler",
  "the grant renewal flow",
  "the snapshot installer",
  "the label picker",
  "the relay reconnect path",
  "the comment editor",
  "the issue search index",
  "the LAN discovery beacon",
  "the compaction floor",
  "the keyboard shortcut map",
  "the empty state",
  "the avatar cache",
  "the migration runner",
] as const;

export const REASONS = [
  "before the beta",
  "so it survives a cold start",
  "on slow networks",
  "for the mobile layout",
  "without breaking the API",
  "under load",
  "for screen readers",
  "when two devices race",
  "after the schema change",
  "in the offline case",
] as const;

export const REMARKS = [
  "Reproduced on the train this morning — it only shows up after a reconnect.",
  "I think this is the same root cause as the flaky test in CI.",
  "Took a first pass; the tricky part is the ordering, not the write.",
  "Can we split this? The second half is a week on its own.",
  "Confirmed fixed on my device after the last fold.",
  "Leaving this in triage until design have looked at it.",
  "The profile says we spend most of it in the validator, not the fold.",
  "Happy to pick this up if nobody has started.",
  "This is blocked on the relay work landing first.",
  "Nice — that shaved about 40ms off the first paint.",
] as const;

export const EMOJI = ["👍", "🎉", "🐛", "🚀", "👀", "❤️"] as const;
