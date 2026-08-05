# Qwen Agent Studio

> A Firefox extension that transforms [chat.qwen.ai](https://chat.qwen.ai/) into a real coding agent with tool calling, project workspace, and a terminal — like Opencode / Cursor, but running entirely inside your browser, on top of Qwen.

![Qwen Agent Studio](icons/icon-128.png)

## What it does

When you open `https://chat.qwen.ai/` with this extension installed, it:

1. **Injects a system prompt** before each user message, teaching Qwen how to call tools using a simple XML syntax.
2. **Detects tool calls** in Qwen's responses, executes them in the browser, and **feeds the results back** to Qwen so the conversation continues as an agent loop.
3. **Provides a sidebar UI** (toggle via floating button) with:
   - A project switcher (create / open / delete projects)
   - A file tree of the active project
   - A "Tool calls" console showing every call, params, status, and result
4. **Persists projects** in the browser's Origin Private File System (OPFS) — sandboxed per extension, no OS folder access required.
5. **Exports** any project to a single JSON file in your Downloads folder.

## Available tools

| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the active project |
| `write_file` | Create / overwrite a file (parents auto-created) |
| `patch_file` | Apply a unified diff to an existing file |
| `list_dir` | List directory entries |
| `create_dir` | Create a directory |
| `delete_path` | Delete a file or directory (recursive) |
| `move_path` | Move / rename |
| `search_files` | Regex search across all files |
| `run_terminal` | Run a sandboxed shell command (ls, cat, grep, find, wc, head, tail, sort, uniq, tree) |
| `web_fetch` | Fetch a URL and return stripped text (for docs lookup) |
| `project_info` | Project metadata (file count, size, language stats) |
| `finish` | Signal task completion |

## Architecture

```
+--------------------------------------------------------------+
|  chat.qwen.ai  (page)                                        |
|  +--------------------------------------------------------+  |
|  |  content.js                                            |  |
|  |   - intercepts Enter / Send button                     |  |
|  |   - prepends system prompt + project context           |  |
|  |   - watches assistant responses                        |  |
|  |   - parses tool call blocks                            |  |
|  |   - renders sidebar UI (file tree, console)            |  |
|  +-------------------+------------------------------------+  |
|                      | chrome.runtime.sendMessage         |
|  +-------------------v------------------------------------+  |
|  |  background.js  (service worker)                       |  |
|  |   - OPFS read/write/list/delete                        |  |
|  |   - tool dispatcher                                    |  |
|  |   - web_fetch via fetch()                              |  |
|  |   - project export via browser.downloads               |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
```

## How tool calls work

1. User types "Create a hello world Node.js project" and hits Enter.
2. The content script intercepts the Enter key, prepends the system prompt and the project context block, then sends the combined message to Qwen.
3. Qwen responds with prose plus one or more tool call blocks.
4. The content script detects the tool calls (once the response stabilizes), sends them to the background service worker for execution, and logs each call in the sidebar console.
5. The content script composes a follow-up user message containing tool result blocks, sends it, and Qwen continues the loop.
6. When Qwen emits a finish tool call, the loop stops.

## Installation

### Temporary install (development)

1. Open Firefox / IronFox.
2. Visit `about:debugging#/runtime/this-firefox`.
3. Click "Load Temporary Add-on...".
4. Select the `manifest.json` file from this repo.

### Permanent install (via IronFox)

The IronFox fork at [deivid22srk/ironfox-qwen](https://github.com/deivid22srk/ironfox-qwen) bundles this extension as a **built-in add-on**, so it's pre-installed on every IronFox build.

### Manual install via web-ext

```bash
npm install -g web-ext
web-ext build --source-dir .
# produces qwen_agent_studio-0.1.0.zip
```

## File structure

```
qwen-agent-extension/
├── manifest.json
├── src/
│   ├── background.js         (service worker — OPFS, tools, dispatcher)
│   ├── content.js            (injected on chat.qwen.ai)
│   ├── content.css           (sidebar styles)
│   ├── lib/
│   │   ├── prompts.js        (tool definitions, system prompt, parser)
│   │   └── sanitize.js       (path sanitization, glob, language hint)
│   ├── popup/
│   │   ├── popup.html / .css / .js
│   └── options/
│       └── options.html / .css / .js
├── icons/
│   └── icon-{16,32,48,96,128}.png
└── README.md
```

## Security model

- **No OS file access.** All files live in OPFS, sandboxed to this extension's origin. The agent cannot read or write outside this sandbox.
- **Path sanitization.** All paths from the LLM are sanitized to reject traversal, absolute paths, and control characters.
- **Terminal allowlist.** The `run_terminal` tool only accepts commands on a configurable allowlist (default: read-only utilities). No rm, no mv, no shell pipes to other binaries.
- **`web_fetch` is opt-in** and uses `credentials: 'omit'` to avoid leaking cookies to arbitrary URLs.

## Limitations

- **Qwen web UI is a moving target.** The DOM selectors used by the content script may need updates if Qwen changes their SPA.
- **OPFS is not your OS folder.** Use "Export JSON" to download a snapshot, or wait for v0.2 which will add folder import via File System Access API.
- **Manifest V3 on Firefox for Android.** MV3 is supported on Firefox for Android 121+, but background service workers may be suspended more aggressively on mobile.

## Roadmap

- [ ] v0.2 — Import folder via `showDirectoryPicker` (desktop)
- [ ] v0.2 — Two-way sync between OPFS project and OS folder (desktop)
- [ ] v0.3 — Multi-file editor in the sidebar (read + edit + save)
- [ ] v0.3 — Diff viewer for `patch_file`
- [ ] v0.4 — Per-project system prompt customization
- [ ] v0.4 — "Run" button for runnable projects (Node.js via WASI, Python via Pyodide)

## License

MIT — see [LICENSE](LICENSE).

## Author

Deividgames — [github.com/deivid22srk](https://github.com/deivid22srk)
