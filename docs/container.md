# Container deployment

The published LearnHarness image runs the standalone Next.js server on port `3000`. Ollama remains a separate service on port `11434`; the application connects to it through `OLLAMA_BASE_URL`.

## Pull and run

```bash
docker pull ghcr.io/fullmoonshade/learnharness:0.3.8-ollama
docker volume create learnharness-state
docker run --detach \
  --name learnharness \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  --env OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  --env OLLAMA_MAX_TOKENS=8192 \
  --publish 127.0.0.1:3000:3000 \
  --volume learnharness-state:/var/lib/learnharness \
  ghcr.io/fullmoonshade/learnharness:0.3.8-ollama
```

Open `http://localhost:3000`.

The named volume preserves chats, graph records, settings, API keys, subscription credentials, and local caches. The image runs as the unprivileged `learnharness` user with UID/GID `1001`.

`host.docker.internal` is built into Docker Desktop. The `--add-host` option provides the same hostname on Linux. A host Ollama process must listen on an interface reachable through Docker; a loopback-only `127.0.0.1:11434` listener is not reachable from a Linux container. One option is:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Protect port `11434` with the host firewall. It does not need to be published to other machines.

The repository's `compose.yaml` provides the same LearnHarness configuration:

```bash
docker compose up -d
docker compose pull
docker compose up -d
```

## Network boundary

LearnHarness does not currently authenticate web users. The example publishes port `3000` on host loopback only. Do not change it to `3000:3000` on an untrusted host. Use SSH forwarding, a private network, or an authenticated reverse proxy for remote access. A reverse proxy must preserve streaming and disable response buffering.

## Build and publish

Authenticate with a GitHub token that can write packages:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io --username fullmoonshade --password-stdin
```

Then publish both supported Linux architectures:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/fullmoonshade/learnharness:0.3.8-ollama \
  --tag ghcr.io/fullmoonshade/learnharness:ollama \
  --push .
```

`.github/workflows/container.yml` publishes version, major/minor, commit, and `latest` tags for future `v*` tags. It attaches provenance and an SBOM. The GHCR package must be public for anonymous pulls; otherwise recipients must authenticate with `read:packages` access.

## Image design

The multi-stage `Dockerfile`:

1. Installs locked dependencies under Node 26 on Debian/glibc.
2. Builds Next.js standalone output.
3. runs the provider trace gate and `scripts/build-server.mjs`, which adds static assets and refuses leaked data or credentials.
4. Copies only the curated standalone payload into the runtime image.
5. Installs Chromium for generated-demo verification and exposes it through `CHROME_PATH`.

Mutable data lives only under `/var/lib/learnharness`. `LH_DATA_DIR` points at its `data` child and `LH_AUTH_FILE` points at `auth.json` in the volume root, so subscription credential files are persisted beside the auth store.

Build each architecture natively through Buildx. Canvas and resvg use architecture-specific native packages, so an image built only for `linux/amd64` cannot run on ARM64.
