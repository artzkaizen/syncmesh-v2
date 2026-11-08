import { createIndexedDbKeyHolder, createWebCryptoVault, platformVault } from "@syncmesh/client";
import { bytesToHex, hexToBytes } from "@syncmesh/wire";

/**
 * What `keystore.test.ts` drives in Chromium (gaps U4): the default vault over the origin's real
 * IndexedDB. The sealed seed is handed back as hex, standing in for the row a database keeps.
 */
const vault = () => createWebCryptoVault();

const keystore = {
  kind: () => platformVault()?.kind,
  seal: async (seedHex: string) => bytesToHex(await vault().seal(hexToBytes(seedHex).unwrap())),
  open: async (sealedHex: string) =>
    vault()
      .open(hexToBytes(sealedHex).unwrap())
      .then(bytesToHex, (cause: unknown) => `refused: ${String(cause)}`),
  /** What a script on the page would try: read the key's bytes out of the browser. */
  exportKey: async () => {
    const key = await createIndexedDbKeyHolder().get();
    if (key === undefined) return "no key";
    return crypto.subtle.exportKey("raw", key).then(
      () => "exported",
      (cause: unknown) => `refused: ${String(cause)}`,
    );
  },
  /** Clears the keystore the way clearing the site's IndexedDB would. */
  clear: () =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("syncmesh-keystore");
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () => reject(request.error));
    }),
};

Object.assign(globalThis, { keystore });
