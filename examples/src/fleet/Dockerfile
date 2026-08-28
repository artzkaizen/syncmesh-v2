# Built from the repository root so the workspace resolves: the relay is not published yet.
#   docker compose -f examples/src/fleet/compose.yaml up --build
FROM oven/bun:1

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

ENV PORT=5198 DATA_DIR=/data
EXPOSE 5198

# `--conditions` picks the workspace's source entry points, so the image needs no build step
CMD ["bun", "--conditions=@syncmesh/source", "examples/src/fleet/relay.ts"]
