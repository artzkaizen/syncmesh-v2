import raw from "../wire-vectors.json" with { type: "json" };

export interface WireVector {
  readonly description: string;
  readonly coreHex: string;
  readonly sigHex: string;
}

export interface WireVectors {
  readonly peerId: string;
  readonly vectors: readonly WireVector[];
}

export const wireVectors: WireVectors = raw;
