/* Qwen Agent Studio - Path & input sanitization
 *
 * Garante que paths fornecidos pelo LLM não escapem do workspace
 * (sem ../, sem absoluto, sem null bytes, etc).
 */

const FORBIDDEN_NAME_FRAGMENT = /[\x00-\x1f<>:"|?*]/;

function sanitizeRelativePath(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Path must be a string');
  }
  let p = raw.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (p.length === 0 || p === '.') return '';
  // Remove null bytes & control chars
  if (FORBIDDEN_NAME_FRAGMENT.test(p)) {
    throw new Error(`Path contains forbidden characters: ${JSON.stringify(raw)}`);
  }
  const segments = p.split('/').filter(s => s.length > 0);
  const cleaned = [];
  for (const s of segments) {
    if (s === '.') continue;
    if (s === '..') {
      throw new Error(`Path traversal not allowed: ${JSON.stringify(raw)}`);
    }
    if (s === '') continue;
    cleaned.push(s);
  }
  return cleaned.join('/');
}

function joinPath(...parts) {
  const segs = [];
  for (const p of parts) {
    const s = sanitizeRelativePath(p);
    if (s) segs.push(s);
  }
  return segs.join('/');
}

function splitPath(p) {
  const s = sanitizeRelativePath(p);
  if (!s) return [];
  return s.split('/');
}

function dirname(p) {
  const segs = splitPath(p);
  if (segs.length <= 1) return '';
  segs.pop();
  return segs.join('/');
}

function basename(p) {
  const segs = splitPath(p);
  return segs.length ? segs[segs.length - 1] : '';
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  if (i <= 0) return '';
  return b.slice(i);
}

// Match a glob pattern like "*.js" or "src/*.ts".
// Supports * (any chars except /) and ** (any chars including /).
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

// Language hint based on file extension, for UI syntax highlighting hint.
function languageForPath(p) {
  const ext = extname(p).toLowerCase();
  const map = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'jsx',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.yml': 'yaml', '.yaml': 'yaml',
    '.json': 'json',
    '.md': 'markdown',
    '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss',
    '.xml': 'xml',
    '.sql': 'sql',
    '.toml': 'toml',
    '.ini': 'ini',
    '.txt': 'text'
  };
  return map[ext] || 'text';
}

window.QwenStudio = window.QwenStudio || {};
window.QwenStudio.sanitize = {
  sanitizeRelativePath,
  joinPath,
  splitPath,
  dirname,
  basename,
  extname,
  globToRegex,
  languageForPath
};
