import { describe, expect, test } from "bun:test";

import { hostOf } from "../host.js";

describe("the host the platform meant", () => {
  test("a whole URL from React Native gives up its hostname", () => {
    expect(hostOf("http://10.1.72.5:8081/")).toBe("10.1.72.5");
  });

  test("`host:port` from Expo gives up the half before the colon", () => {
    expect(hostOf("10.1.72.5:8081")).toBe("10.1.72.5");
  });

  test("a bare host is already the answer", () => {
    expect(hostOf("desktop.local")).toBe("desktop.local");
  });

  // every one of these is a source that was absent in a dev client on the New Architecture, and
  // the reason `localhost` — which means *this phone* — used to be what a device dialled
  test("nothing in is nothing out, rather than a dialable nonsense string", () => {
    expect(hostOf(undefined)).toBeUndefined();
    expect(hostOf("")).toBeUndefined();
    expect(hostOf(":8081")).toBeUndefined();
  });

  test("a URL this runtime cannot parse is one more source with no answer, not a throw", () => {
    expect(hostOf("http://")).toBeUndefined();
  });
});
