/* Qwen Agent Studio - Background service worker
 *
 * Responsável por:
 *   1. Gerenciar projetos no OPFS (Origin Private File System)
 *   2. Executar tools (read_file, write_file, list_dir, etc.)
 *   3. Exportar arquivos via browser.downloads
 *   4. Comunicação com content script via runtime.sendMessage
 *
 * O OPFS é um storage sandboxed por origem: a extensão só vê os
 * arquivos que ela mesma criou. Para o usuário final, "selecionar
 * uma pasta do dispositivo" é exposto como "escolher/importar pasta"
 * via File System Access API no popup, com fallback para upload
 * manual de arquivos no mobile (onde showDirectoryPicker não existe).
 */

// =========================================================================
// State
// =========================================================================

const state = {
  activeProject: null,        // { name, rootDirHandle }
  projects: [],               // [{ name, createdAt }]
  toolCallLog: [],            // [{ id, name, params, result, ts }]
  settings: {
    autoInjectSystemPrompt: true,
    showSidebar: true,
    maxToolCallsPerTurn: 12,
    allowWebFetch: true,
    terminalAllowlist: [
      'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'grep', 'find',
      'sort', 'uniq', 'tree', 'file', 'stat', 'du', 'df', 'env', 'whoami',
      'date', 'cal', 'which', 'type'
    ]
  }
};

// =========================================================================
// OPFS helpers
// =========================================================================

async function opfsRoot() {
  return await navigator.storage.getDirectory();
}

async function projectsRoot() {
  const root = await opfsRoot();
  return await root.getDirectoryHandle('projects', { create: true });
}

async function listProjects() {
  const root = await projectsRoot();
  const out = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory') {
      out.push({ name, createdAt: 0 });
    }
  }
  state.projects = out;
  return out;
}

async function getProjectDir(name) {
  const root = await projectsRoot();
  return await root.getDirectoryHandle(name, { create: true });
}

async function createProject(name) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error('Invalid project name');
  const dir = await getProjectDir(safe);
  state.activeProject = { name: safe, rootDirHandle: dir };
  await persistState();
  return state.activeProject;
}

async function deleteProject(name) {
  const safe = sanitizeName(name);
  const root = await projectsRoot();
  await root.removeEntry(safe, { recursive: true });
  if (state.activeProject && state.activeProject.name === safe) {
    state.activeProject = null;
  }
  await persistState();
}

function sanitizeName(name) {
  if (typeof name !== 'string') return '';
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 64);
}

// =========================================================================
// File operations (within active project)
// =========================================================================

async function resolvePath(dirHandle, segments, { create = false } = {}) {
  let cur = dirHandle;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    // We assume directory traversal; the final segment may be a file or dir,
    // depending on the calling context. Caller passes the right method.
    cur = await cur.getDirectoryHandle(seg, { create });
  }
  return cur;
}

async function ensureParentDir(dirHandle, segments) {
  let cur = dirHandle;
  for (const seg of segments) {
    cur = await cur.getDirectoryHandle(seg, { create: true });
  }
  return cur;
}

async function toolReadFile({ path }) {
  if (!state.activeProject) throw new Error('No active project');
  const segs = splitSegments(path);
  if (segs.length === 0) throw new Error('Empty path');
  const fileName = segs.pop();
  const parent = segs.length === 0
    ? state.activeProject.rootDirHandle
    : await resolvePath(state.activeProject.rootDirHandle, segs);
  const fh = await parent.getFileHandle(fileName);
  const file = await fh.getFile();
  return await file.text();
}

async function toolWriteFile({ path, content }) {
  if (!state.activeProject) throw new Error('No active project');
  const segs = splitSegments(path);
  if (segs.length === 0) throw new Error('Empty path');
  const fileName = segs.pop();
  const parent = segs.length === 0
    ? state.activeProject.rootDirHandle
    : await ensureParentDir(state.activeProject.rootDirHandle, segs);
  const fh = await parent.getFileHandle(fileName, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return `Wrote ${content.length} bytes to ${path}`;
}

async function toolListDir({ path = '' } = {}) {
  if (!state.activeProject) throw new Error('No active project');
  const segs = splitSegments(path);
  const dir = segs.length === 0
    ? state.activeProject.rootDirHandle
    : await resolvePath(state.activeProject.rootDirHandle, segs);
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      out.push({ name, type: 'dir' });
    } else {
      const file = await handle.getFile();
      out.push({ name, type: 'file', size: file.size });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

async function toolCreateDir({ path }) {
  if (!state.activeProject) throw new Error('No active project');
  const segs = splitSegments(path);
  await ensureParentDir(state.activeProject.rootDirHandle, segs);
  return `Created directory ${path}`;
}

async function toolDeletePath({ path }) {
  if (!state.activeProject) throw new Error('No active project');
  const segs = splitSegments(path);
  if (segs.length === 0) throw new Error('Empty path');
  const name = segs.pop();
  const parent = segs.length === 0
    ? state.activeProject.rootDirHandle
    : await resolvePath(state.activeProject.rootDirHandle, segs);
  // Try both file and dir removal
  try {
    await parent.removeEntry(name, { recursive: true });
    return `Deleted ${path}`;
  } catch (e) {
    throw new Error(`Could not delete ${path}: ${e.message}`);
  }
}

async function toolMovePath({ from, to }) {
  if (!state.activeProject) throw new Error('No active project');
  // Read source
  const content = await toolReadFile({ path: from });
  // Write to dest
  await toolWriteFile({ path: to, content });
  // Remove source
  await toolDeletePath({ path: from });
  return `Moved ${from} -> ${to}`;
}

async function toolSearchFiles({ pattern, glob }) {
  if (!state.activeProject) throw new Error('No active project');
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex: ${e.message}`);
  }
  const globRe = glob ? globToRegex(glob) : null;
  const results = [];
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const full = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walk(handle, full);
      } else {
        if (globRe && !globRe.test(full)) continue;
        const file = await handle.getFile();
        const text = await file.text();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ path: full, line: i + 1, snippet: lines[i].slice(0, 200) });
            if (results.length >= 100) return;
          }
        }
      }
    }
  }
  await walk(state.activeProject.rootDirHandle, '');
  return results;
}

async function toolRunTerminal({ command }) {
  if (!state.activeProject) throw new Error('No active project');
  // Very limited sandboxed shell: parse argv[0], ensure allowlist,
  // simulate ls/cat/grep/find/wc/head/tail against OPFS.
  const trimmed = (command || '').trim();
  if (!trimmed) throw new Error('Empty command');
  const parts = parseShellLike(trimmed);
  if (parts.length === 0) throw new Error('Could not parse command');
  const bin = parts[0];
  if (!state.settings.terminalAllowlist.includes(bin)) {
    throw new Error(`Command not allowed: ${bin}. Allowed: ${state.settings.terminalAllowlist.join(', ')}`);
  }
  return await runSandboxedCommand(bin, parts.slice(1));
}

function parseShellLike(s) {
  // Simple tokenizer: split on whitespace, respect single/double quotes.
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; }
      else { cur += c; }
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function runSandboxedCommand(bin, args) {
  switch (bin) {
    case 'pwd':
      return '/workspace';
    case 'whoami':
      return 'qwen-agent';
    case 'date':
      return new Date().toString();
    case 'echo':
      return args.join(' ');
    case 'ls': {
      const target = args.filter(a => !a.startsWith('-'))[0] || '';
      const longFmt = args.some(a => a.startsWith('-l'));
      const entries = await toolListDir({ path: target });
      if (longFmt) {
        return entries.map(e => {
          if (e.type === 'dir') return `drwxr-xr-x  1 agent  agent        0  ${e.name}`;
          return `-rw-r--r--  1 agent  agent  ${String(e.size).padStart(8)}  ${e.name}`;
        }).join('\n');
      }
      return entries.map(e => e.type === 'dir' ? e.name + '/' : e.name).join('\n');
    }
    case 'cat': {
      if (args.length === 0) throw new Error('cat: missing file');
      const out = [];
      for (const a of args) {
        out.push(await toolReadFile({ path: a }));
      }
      return out.join('\n');
    }
    case 'head': {
      const n = args.find(a => a.startsWith('-n'));
      const count = n ? parseInt(n.split('=')[1] || n.slice(2), 10) : 10;
      const file = args.filter(a => !a.startsWith('-'))[0];
      if (!file) throw new Error('head: missing file');
      const text = await toolReadFile({ path: file });
      return text.split('\n').slice(0, count).join('\n');
    }
    case 'tail': {
      const n = args.find(a => a.startsWith('-n'));
      const count = n ? parseInt(n.split('=')[1] || n.slice(2), 10) : 10;
      const file = args.filter(a => !a.startsWith('-'))[0];
      if (!file) throw new Error('tail: missing file');
      const text = await toolReadFile({ path: file });
      const lines = text.split('\n');
      return lines.slice(Math.max(0, lines.length - count)).join('\n');
    }
    case 'wc': {
      const file = args.filter(a => !a.startsWith('-'))[0];
      if (!file) throw new Error('wc: missing file');
      const text = await toolReadFile({ path: file });
      const lines = text.split('\n').length;
      const words = text.split(/\s+/).filter(Boolean).length;
      const bytes = text.length;
      return `${lines} ${words} ${bytes} ${file}`;
    }
    case 'grep': {
      // grep PATTERN FILE
      const flags = args.filter(a => a.startsWith('-'));
      const rest = args.filter(a => !a.startsWith('-'));
      if (rest.length < 2) throw new Error('grep: usage: grep PATTERN FILE');
      const pattern = rest[0];
      const file = rest[1];
      let re;
      try { re = new RegExp(pattern, flags.includes('-i') ? 'i' : ''); }
      catch (e) { throw new Error(`grep: invalid regex: ${e.message}`); }
      const text = await toolReadFile({ path: file });
      const lines = text.split('\n');
      const matched = lines.filter(l => re.test(l));
      return matched.join('\n');
    }
    case 'find': {
      // Simplified: find [PATH] -name GLOB
      const pathArg = args.filter(a => !a.startsWith('-') && !a.includes('='))[0] || '';
      const nameIdx = args.indexOf('-name');
      const nameGlob = nameIdx >= 0 ? args[nameIdx + 1] : null;
      const results = [];
      async function walk(dir, prefix) {
        for await (const [name, handle] of dir.entries()) {
          const full = prefix ? `${prefix}/${name}` : name;
          if (handle.kind === 'directory') {
            if (!nameGlob || matchesGlob(full, nameGlob)) results.push(full + '/');
            await walk(handle, full);
          } else {
            if (!nameGlob || matchesGlob(name, nameGlob)) results.push(full);
          }
        }
      }
      const startDir = pathArg ? await resolvePath(state.activeProject.rootDirHandle, splitSegments(pathArg)) : state.activeProject.rootDirHandle;
      await walk(startDir, pathArg);
      return results.join('\n');
    }
    case 'sort': {
      const file = args.filter(a => !a.startsWith('-'))[0];
      if (!file) throw new Error('sort: missing file');
      const text = await toolReadFile({ path: file });
      return text.split('\n').sort().join('\n');
    }
    case 'uniq': {
      const file = args.filter(a => !a.startsWith('-'))[0];
      if (!file) throw new Error('uniq: missing file');
      const text = await toolReadFile({ path: file });
      const lines = text.split('\n');
      const out = [];
      let prev = null;
      for (const l of lines) {
        if (l !== prev) out.push(l);
        prev = l;
      }
      return out.join('\n');
    }
    case 'tree': {
      const out = [];
      async function walk(dir, prefix, isLast) {
        const entries = [];
        for await (const [name, handle] of dir.entries()) {
          entries.push({ name, handle });
        }
        entries.sort((a, b) => {
          if (a.handle.kind !== b.handle.kind) return a.handle.kind === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const last = i === entries.length - 1;
          const branch = last ? '└── ' : '├── ';
          out.push(prefix + branch + e.name + (e.handle.kind === 'directory' ? '/' : ''));
          if (e.handle.kind === 'directory') {
            await walk(e.handle, prefix + (last ? '    ' : '│   '), last);
          }
        }
      }
      await walk(state.activeProject.rootDirHandle, '', true);
      return out.join('\n');
    }
    default:
      throw new Error(`Command not implemented: ${bin}`);
  }
}

function matchesGlob(name, glob) {
  // Simple shell glob: * = any chars except /, ? = single char.
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  return re.test(name);
}

async function toolPatchFile({ path, diff }) {
  const original = await toolReadFile({ path });
  const patched = applyUnifiedDiff(original, diff);
  if (patched === null) {
    throw new Error('Could not apply diff (hunk mismatch)');
  }
  await toolWriteFile({ path, content: patched });
  return `Patched ${path} (${patched.length} bytes)`;
}

function applyUnifiedDiff(original, diff) {
  // Minimal unified-diff applier: supports @@ -a,b +c,d @@ hunks with
  // context lines (starting with space), removals (-), and additions (+).
  const lines = original.split('\n');
  const result = [];
  let idx = 0; // 0-based into `lines`
  const diffLines = diff.split('\n');
  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i];
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!hunkMatch) {
      i++;
      continue;
    }
    const startOld = parseInt(hunkMatch[1], 10) - 1; // 0-based
    if (startOld < idx) return null;
    // Copy unchanged lines up to hunk start
    while (idx < startOld) {
      result.push(lines[idx]);
      idx++;
    }
    i++;
    // Process hunk body
    while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
      const h = diffLines[i];
      if (h.startsWith('---') || h.startsWith('+++') || h === '') {
        i++;
        continue;
      }
      if (h.startsWith('-')) {
        // Expected removal: skip the line in original
        if (idx >= lines.length) return null;
        idx++;
      } else if (h.startsWith('+')) {
        result.push(h.slice(1));
      } else if (h.startsWith(' ')) {
        if (idx >= lines.length) return null;
        if (lines[idx] !== h.slice(1)) return null;
        result.push(lines[idx]);
        idx++;
      } else if (h.startsWith('\\')) {
        // "\ No newline at end of file" - ignore
      } else {
        // Unknown line; bail
        return null;
      }
      i++;
    }
  }
  // Copy remaining
  while (idx < lines.length) {
    result.push(lines[idx]);
    idx++;
  }
  return result.join('\n');
}

async function toolWebFetch({ url, selector }) {
  if (!state.settings.allowWebFetch) {
    throw new Error('web_fetch disabled in settings');
  }
  let u;
  try { u = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (!u.protocol.startsWith('http')) {
    throw new Error('Only http(s) URLs allowed');
  }
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return await resp.text();
  }
  const html = await resp.text();
  // Parse HTML in DOMParser (available in service worker? No - use regex fallback.)
  // In MV3 service workers, DOMParser is NOT available. Use a simple tag stripper.
  let text = html;
  if (selector) {
    // Best-effort: extract block via regex on tag name
    const tagName = selector.replace(/[<>.#]/g, '').split(/\s+/)[0];
    if (tagName) {
      const re = new RegExp('<' + tagName + '[^>]*>([\\s\\S]*?)</' + tagName + '>', 'i');
      const m = html.match(re);
      if (m) text = m[1];
    }
  }
  // Strip scripts/styles
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<style[\s\S]*?<\/style>/gi, '')
             .replace(/<!--[\s\S]*?-->/g, '');
  // Tags -> newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|td|th|br|pre|code)>/gi, '\n')
             .replace(/<br\s*\/?>/gi, '\n')
             .replace(/<[^>]+>/g, '');
  // Decode common entities
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'");
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  // Limit
  if (text.length > 8000) text = text.slice(0, 8000) + '\n... [truncated]';
  return text;
}

async function toolProjectInfo() {
  if (!state.activeProject) throw new Error('No active project');
  const stats = { fileCount: 0, totalBytes: 0, byExt: {} };
  async function walk(dir) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        await walk(handle);
      } else {
        const file = await handle.getFile();
        stats.fileCount++;
        stats.totalBytes += file.size;
        const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '(none)';
        stats.byExt[ext] = (stats.byExt[ext] || 0) + 1;
      }
    }
  }
  await walk(state.activeProject.rootDirHandle);
  return {
    name: state.activeProject.name,
    ...stats
  };
}

// =========================================================================
// Tool dispatcher
// =========================================================================

const TOOL_HANDLERS = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  patch_file: toolPatchFile,
  list_dir: toolListDir,
  create_dir: toolCreateDir,
  delete_path: toolDeletePath,
  move_path: toolMovePath,
  search_files: toolSearchFiles,
  run_terminal: toolRunTerminal,
  web_fetch: toolWebFetch,
  project_info: toolProjectInfo,
  finish: async ({ summary }) => ({ done: true, summary })
};

async function executeTool(call) {
  const handler = TOOL_HANDLERS[call.name];
  if (!handler) {
    return { ok: false, error: `Unknown tool: ${call.name}` };
  }
  if (call.error) {
    return { ok: false, error: call.error };
  }
  try {
    const result = await handler(call.params);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// =========================================================================
// Utilities
// =========================================================================

function splitSegments(path) {
  if (!path) return [];
  return String(path).replace(/\\/g, '/').split('/').filter(s => s && s !== '.');
}

function globToRegex(glob) {
  if (!glob) return null;
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '[\\s\\S]*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

// =========================================================================
// Persistence
// =========================================================================

async function persistState() {
  try {
    await chrome.storage.local.set({
      activeProjectName: state.activeProject ? state.activeProject.name : null,
      settings: state.settings
    });
  } catch (e) {
    console.warn('[QwenStudio] persistState error:', e);
  }
}

async function loadState() {
  try {
    const data = await chrome.storage.local.get(['activeProjectName', 'settings']);
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
    }
    await listProjects();
    if (data.activeProjectName && state.projects.some(p => p.name === data.activeProjectName)) {
      state.activeProject = {
        name: data.activeProjectName,
        rootDirHandle: await getProjectDir(data.activeProjectName)
      };
    }
  } catch (e) {
    console.warn('[QwenStudio] loadState error:', e);
  }
}

// =========================================================================
// Message handling
// =========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'PING':
          sendResponse({ ok: true, pong: Date.now(), activeProject: state.activeProject?.name });
          return;
        case 'LIST_PROJECTS':
          sendResponse({ ok: true, projects: await listProjects() });
          return;
        case 'CREATE_PROJECT':
          sendResponse({ ok: true, project: await createProject(msg.name) });
          return;
        case 'SELECT_PROJECT':
          if (!state.projects.some(p => p.name === msg.name)) {
            sendResponse({ ok: false, error: 'Project does not exist' });
            return;
          }
          state.activeProject = {
            name: msg.name,
            rootDirHandle: await getProjectDir(msg.name)
          };
          await persistState();
          sendResponse({ ok: true, project: state.activeProject });
          return;
        case 'DELETE_PROJECT':
          await deleteProject(msg.name);
          sendResponse({ ok: true });
          return;
        case 'GET_STATE':
          sendResponse({
            ok: true,
            state: {
              activeProject: state.activeProject?.name || null,
              projects: state.projects,
              settings: state.settings
            }
          });
          return;
        case 'EXECUTE_TOOL':
          sendResponse({ ok: true, result: await executeTool(msg.call) });
          return;
        case 'IMPORT_FILES': {
          // msg.files = [{ path, content }]
          if (!state.activeProject) {
            sendResponse({ ok: false, error: 'No active project' });
            return;
          }
          let n = 0;
          for (const f of msg.files) {
            await toolWriteFile({ path: f.path, content: f.content });
            n++;
          }
          sendResponse({ ok: true, count: n });
          return;
        }
        case 'EXPORT_PROJECT': {
          if (!state.activeProject) {
            sendResponse({ ok: false, error: 'No active project' });
            return;
          }
          // Pack all files into a single JSON manifest, download via browser.downloads
          const manifest = { project: state.activeProject.name, files: [] };
          async function walk(dir, prefix) {
            for await (const [name, handle] of dir.entries()) {
              const full = prefix ? `${prefix}/${name}` : name;
              if (handle.kind === 'directory') {
                await walk(handle, full);
              } else {
                const file = await handle.getFile();
                const text = await file.text();
                manifest.files.push({ path: full, content: text });
              }
            }
          }
          await walk(state.activeProject.rootDirHandle, '');
          const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const filename = `${state.activeProject.name}-${ts}.qwenstudio.json`;
          await chrome.downloads.download({
            url,
            filename,
            saveAs: true
          });
          sendResponse({ ok: true, count: manifest.files.length });
          return;
        }
        case 'GET_FILE_TREE': {
          if (!state.activeProject) {
            sendResponse({ ok: false, error: 'No active project' });
            return;
          }
          const tree = { name: state.activeProject.name, type: 'dir', children: [] };
          async function walk(dir, node) {
            for await (const [name, handle] of dir.entries()) {
              if (handle.kind === 'directory') {
                const child = { name, type: 'dir', children: [] };
                node.children.push(child);
                await walk(handle, child);
              } else {
                const file = await handle.getFile();
                node.children.push({ name, type: 'file', size: file.size });
              }
            }
            node.children.sort((a, b) => {
              if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
              return a.name.localeCompare(b.name);
            });
          }
          await walk(state.activeProject.rootDirHandle, tree);
          sendResponse({ ok: true, tree });
          return;
        }
        case 'UPDATE_SETTINGS':
          state.settings = { ...state.settings, ...msg.settings };
          await persistState();
          sendResponse({ ok: true, settings: state.settings });
          return;
        case 'GET_PROJECT_CONTEXT': {
          if (!state.activeProject) {
            sendResponse({ ok: false, error: 'No active project' });
            return;
          }
          const stats = { fileCount: 0, totalBytes: 0 };
          const root = await toolListDir({ path: '' });
          async function countFiles(dir) {
            for (const e of dir) {
              if (e.type === 'dir') {
                const sub = await toolListDir({ path: e.name });
                await countFiles(sub);
              } else {
                stats.fileCount++;
                stats.totalBytes += e.size;
              }
            }
          }
          // Note: counting nested dirs properly would require recursion with path
          // For brevity here we only count root level files. The full walk is
          // already provided by toolProjectInfo if needed.
          sendResponse({
            ok: true,
            context: {
              name: state.activeProject.name,
              rootListing: root,
              stats
            }
          });
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${msg.type}` });
      }
    } catch (e) {
      console.error('[QwenStudio] message handler error:', e);
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async
});

// On startup
chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  console.log('[QwenStudio] installed, state loaded');
});
chrome.runtime.onStartup.addListener(async () => {
  await loadState();
  console.log('[QwenStudio] startup, state loaded');
});

// Eager load
loadState();
