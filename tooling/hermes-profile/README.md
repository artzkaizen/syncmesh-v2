# hermes-profile

The JS thread's own account of where a stall went, taken from Hermes' sampling profiler over the
dev server's inspector socket.

## Why this exists

Every performance question in this repo so far has been answered by a `Date.now()` around the span
somebody already suspected. That measures the hypothesis, not the program: it can tell you a span
was 900ms and it cannot tell you what ran inside it, so the next step is always a guess, and a
guess that is wrong costs a rebuild, a reload and somebody's afternoon. Three of them in a row is
what prompted this.

A sampling profiler inverts that. It records the whole stack at a fixed rate and lets the
measurement name the function, so the answer arrives before the hypothesis instead of after it.

It also settles the one question a timer on a phone genuinely cannot. `setTimeout` and
`requestAnimationFrame` are both delivered through native modules in React Native, so a gap in
either proves only that _something_ was busy. The sampler runs beside the JS thread: **samples
present** through a stall means JavaScript was running, and the profile says what; **samples
absent** means the JS thread had nothing to do and the stall is the native side. `sampled` in the
report below is that discriminator.

## Use

Start the app, reproduce nothing yet, then:

```sh
bun tools/hermes-profile/profile.ts --seconds 12
```

Do the slow thing while it records. It writes `/tmp/hermes-<when>.cpuprofile` — openable in
Chrome DevTools' Performance panel or Speedscope — and prints the summary:

- **density** — samples per 100ms bucket, so an idle stretch is visible as a run of `·`
- **self** — where the JS thread actually was, hottest first
- **total** — which call trees that time sits under

Flags: `--seconds`, `--out`, `--url` (default `http://localhost:8081`), `--top`.

## What it cannot see

The UI thread and the native modules. A profile that comes back nearly empty over a stall has
answered the question — the time is not JavaScript's — but naming _what_ it is then wants
Instruments or a systrace, not this.
