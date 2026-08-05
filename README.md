# IronFox-Qwen

> A fork of [IronFox](https://ironfoxoss.org/) that bundles the [Qwen Agent Studio](https://github.com/deivid22srk/qwen-agent-extension) extension as a built-in addon, transforming `chat.qwen.ai` into an autonomous coding agent on Android.

![IronFox](assets/ironfox.png)

## What this fork adds

On top of upstream IronFox (Firefox 153.0.3 for Android, hardened):

1. **Qwen Agent Studio extension pre-installed** — the extension from [deivid22srk/qwen-agent-extension](https://github.com/deivid22srk/qwen-agent-extension) is registered as a built-in addon and auto-installed on first launch.
2. **Modified overlay file** — `patches/fenix-overlay/.../IronFoxAddons.kt` adds the `QWEN_AGENT_STUDIO` addon definition with download URL pointing to the extension's GitHub releases.
3. **GitHub Actions `build.yml`** — two-job CI: (a) validation job that checks patches, extension syntax, and builds the .xpi; (b) full Docker build job that runs the IronFox build inside the official Fedora 43 Docker image.
4. **Bundled extension source** — the full extension source lives in `assets/qwen-agent-extension/` for reference and .xpi packaging.

## What is Qwen Agent Studio?

It transforms `chat.qwen.ai` into a real coding agent:

- **Tool calling** via XML syntax in Qwen responses (`<tool_call name="write_file">...`)
- **Project workspace** stored in browser OPFS (Origin Private File System)
- **Sandboxed terminal** (ls, cat, grep, find, head, tail, wc, sort, uniq, tree)
- **File operations** (read, write, patch, delete, move, search)
- **Web fetch** for docs lookup
- **Sidebar UI** with file tree + tool call console

See the [extension README](assets/qwen-agent-extension/README.md) for full details.

## Build limitations

> **⚠️ IMPORTANT: The GitHub Actions build will likely FAIL on free runners.**

Building Firefox/IronFox for Android requires:
- **~50 GB disk space** (sources + build artifacts)
- **~32 GB RAM** (Gecko + Rust compilation)
- **3-6 hours** wall clock time

GitHub Actions free runners (`ubuntu-22.04`) provide:
- 14 GB disk space (after cleanup)
- 7 GB RAM
- 6 hour job timeout

### What to expect

| Step | Free runner | Self-hosted runner |
|------|------------|-------------------|
| Source download (~10 GB) | ✅ Works | ✅ Works |
| Patch application | ✅ Works | ✅ Works |
| Gecko build (C++/Rust) | ❌ OOM kill | ✅ With 32GB+ RAM |
| Fenix build (Kotlin/Gradle) | ⚠️ May work if Gecko cached | ✅ Works |
| APK packaging | ❌ Blocked by Gecko | ✅ Works |

### Recommended approach

1. **For testing only**: Use the `workflow_dispatch` trigger to run the build. Expect it to fail at the Gecko compilation step. The workflow is configured with `continue-on-error: true` so artifacts (logs) are still uploaded.

2. **For production builds**: Use a self-hosted runner with:
   - 64 GB RAM
   - 200 GB SSD
   - 8+ CPU cores
   - Docker installed
   
   Configure it via Settings → Actions → Runners → New self-hosted runner.

3. **Alternative**: Use the upstream IronFox Docker image on a beefy VPS:
   ```bash
   docker pull registry.gitlab.com/ironfox-oss/ironfox:latest
   docker run -it --rm \
     -v $(pwd):/app \
     -v ironfox-cache:/build \
     --memory=32g --cpus=8 \
     registry.gitlab.com/ironfox-oss/ironfox:latest \
     /bin/bash
   # Inside container:
   bash scripts/env.sh
   bash scripts/get_sources.sh all
   bash scripts/patches.sh
   bash scripts/prebuild.sh
   bash scripts/build.sh arm64 fenix
   ```

## Building locally (Docker, recommended)

```bash
# Clone this repo
git clone https://github.com/deivid22srk/ironfox-qwen.git
cd ironfox-qwen

# Pull the official IronFox build image
docker pull registry.gitlab.com/ironfox-oss/ironfox:latest

# Run the build (needs 32GB+ RAM allocated to Docker)
docker run -it --rm \
  -v $(pwd):/app \
  -v ironfox-build:/build \
  --memory=32g \
  --memory-swap=64g \
  --cpus=8 \
  registry.gitlab.com/ironfox-oss/ironfox:latest \
  /bin/bash -c '
    cd /app &&
    bash scripts/env.sh &&
    bash scripts/get_sources.sh all &&
    bash scripts/patches.sh &&
    bash scripts/prebuild.sh &&
    bash scripts/build.sh arm64 fenix
  '

# Output APK will be in:
# build/src/mobile/android/fenix/app/build/outputs/apk/arm64/release/
```

## Installing the APK

After a successful build:

1. Enable "Install unknown apps" for your file manager in Android Settings.
2. Copy the `app-arm64-release.apk` to your device.
3. Tap to install.
4. Open IronFox, visit `https://chat.qwen.ai/`.
5. The Qwen Agent Studio extension will auto-install on first launch.
6. A floating ◆ button appears bottom-right — tap it to open the sidebar.

## Differences from upstream IronFox

| File | Change |
|------|--------|
| `patches/fenix-overlay/app/src/main/java/org/ironfoxoss/ironfox/utils/IronFoxAddons.kt` | MODIFIED — adds `QWEN_AGENT_STUDIO` addon definition, `isQwenAgentStudio()` method, and includes it in `isBuiltIn()` check |
| `assets/qwen-agent-extension/` | NEW — full extension source (for reference and .xpi packaging) |
| `.github/workflows/build.yml` | NEW — GitHub Actions CI: validation job (always runs) + full Docker build job (manual trigger) |
| `README.md` | MODIFIED — this file |

## License

IronFox is licensed under the MPL 2.0 (see `COPYING.txt`).
The Qwen Agent Studio extension is MIT licensed (see `assets/qwen-agent-extension/LICENSE`).

## Credits

- [IronFox OSS](https://ironfoxoss.org/) — the upstream project
- [Mozilla Firefox](https://www.mozilla.org/firefox/) — the base browser
- [Deividgames](https://github.com/deivid22srk) — this fork + extension

## Links

- [Extension repo](https://github.com/deivid22srk/qwen-agent-extension)
- [Upstream IronFox](https://github.com/ironfox-oss/IronFox)
- [IronFox docs](https://ironfoxoss.org/docs/)
