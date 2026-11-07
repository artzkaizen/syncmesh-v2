// Cases for `syncmesh/no-of-for-suffix`. The repository lints nothing under tools/oxlint, so run
// this by hand from this directory and read the output:
//
//   ../../../../node_modules/.bin/oxlint --config .oxlintrc.json naming.ts
//
// Every statement under "should report" must produce one diagnostic, and nothing under
// "should NOT report" may produce any.

export function grumbleOf(peer: string): string {
	return peer.slice(0, 8);
}

export const wobbleFor = (scope: string): string => `${scope}.db`;

export function peerHint(peer: string): string {
	return peer.slice(0, 8);
}

export function resolvePartition(row: string): string | undefined {
	return row.length > 0 ? row : undefined;
}
