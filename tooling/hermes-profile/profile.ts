/**
 * Record the JS thread for a few seconds and say where it went.
 *
 * `bun tools/hermes-profile/profile.ts --seconds 12`
 *
 * See `./README.md` for why a sampler rather than another timer, and for what a profile that comes
 * back empty is telling you.
 */
import type { CpuProfile } from "./read.js";

import { appAmong, connectTo, targetsAt } from "./cdp.js";
import { printReading, readProfile } from "./read.js";

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const say = (line: string): void => {
  console.log(line);
};

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the runtime's reply is JSON off a socket, and this guard is the parse that makes it a `CpuProfile` */
const isProfile = (value: unknown): value is CpuProfile =>
  typeof value === "object" && value !== null && "samples" in value && "nodes" in value;
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

const record = async (): Promise<void> => {
  const url = flag("url", "http://localhost:8081");
  const seconds = Number(flag("seconds", "10"));
  const top = Number(flag("top", "20"));
  const out = flag("out", `/tmp/hermes-${String(Date.now())}.cpuprofile`);

  const targets = await targetsAt(url);
  const app = appAmong(targets, flag("device", "") || undefined);
  if (app?.webSocketDebuggerUrl === undefined) {
    say(`no runtime attached to ${url}. Open the app on the device, then run this again.`);
    say(
      `  /json/list returned ${String(targets.length)} entr${targets.length === 1 ? "y" : "ies"}`,
    );
    process.exitCode = 1;
    return;
  }
  say(
    `recording ${app.title ?? "the app"} · device ${app.reactNative?.logicalDeviceId?.slice(0, 8) ?? "?"} · ${String(targets.length)} attached`,
  );

  const talk = await connectTo(app.webSocketDebuggerUrl, url);
  try {
    await talk.send("Profiler.enable");
    await talk.send("Profiler.start");
    say(`go — do the slow thing now, for ${String(seconds)}s`);
    await new Promise((done) => setTimeout(done, seconds * 1000));
    const stopped = await talk.send("Profiler.stop");
    const profile: unknown = stopped.profile;
    if (!isProfile(profile)) {
      say("the runtime stopped the profiler but returned no profile");
      process.exitCode = 1;
      return;
    }
    await Bun.write(out, JSON.stringify(profile));
    say(`\nwrote ${out}\n`);
    printReading(readProfile(profile, top), say);
  } finally {
    talk.close();
  }
};

await record();
