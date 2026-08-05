/* Qwen Agent Studio - Prompt and Tool Definitions */

const TOOL_DEFINITIONS = [
  {
    "name": "read_file",
    "description": "Read the full content of a file inside the active project workspace. Returns the file content as a string.",
    "params": {
      "path": {
        "type": "string",
        "required": true,
        "description": "Relative path inside the project, e.g. src/index.js"
      }
    }
  },
  {
    "name": "write_file",
    "description": "Create or overwrite a file inside the active project workspace. Parent directories are created automatically.",
    "params": {
      "path": {
        "type": "string",
        "required": true,
        "description": "Relative path inside the project"
      },
      "content": {
        "type": "string",
        "required": true,
        "description": "Full file content (UTF-8)"
      }
    }
  },
  {
    "name": "patch_file",
    "description": "Apply a unified diff to an existing file. Useful for surgical edits without rewriting the whole file.",
    "params": {
      "path": {
        "type": "string",
        "required": true
      },
      "diff": {
        "type": "string",
        "required": true,
        "description": "Unified diff with hunks"
      }
    }
  },
  {
    "name": "list_dir",
    "description": "List the entries of a directory inside the project workspace.",
    "params": {
      "path": {
        "type": "string",
        "required": false,
        "description": "Relative path. Default: project root."
      }
    }
  },
  {
    "name": "create_dir",
    "description": "Create a directory (and parents) inside the project workspace.",
    "params": {
      "path": {
        "type": "string",
        "required": true
      }
    }
  },
  {
    "name": "delete_path",
    "description": "Delete a file or directory (recursively) inside the project workspace.",
    "params": {
      "path": {
        "type": "string",
        "required": true
      }
    }
  },
  {
    "name": "move_path",
    "description": "Move/rename a file or directory inside the project workspace.",
    "params": {
      "from": {
        "type": "string",
        "required": true
      },
      "to": {
        "type": "string",
        "required": true
      }
    }
  },
  {
    "name": "search_files",
    "description": "Search for a text pattern (regex) across all files in the project. Returns matches with file:line:snippet.",
    "params": {
      "pattern": {
        "type": "string",
        "required": true,
        "description": "JavaScript RegExp source"
      },
      "glob": {
        "type": "string",
        "required": false,
        "description": "Optional glob filter"
      }
    }
  },
  {
    "name": "run_terminal",
    "description": "Run a safe command in a sandboxed virtual terminal. Only read-only and workspace-scoped commands are allowed (ls, cat, grep, find, pwd, echo, wc, head, tail, sort, uniq, etc.). Returns stdout.",
    "params": {
      "command": {
        "type": "string",
        "required": true,
        "description": "Shell command (sandboxed, restricted allowlist)"
      }
    }
  },
  {
    "name": "web_fetch",
    "description": "Fetch a URL and return its text content (HTML stripped to text). Useful for docs lookup.",
    "params": {
      "url": {
        "type": "string",
        "required": true
      },
      "selector": {
        "type": "string",
        "required": false,
        "description": "Optional CSS selector to extract a subtree"
      }
    }
  },
  {
    "name": "project_info",
    "description": "Return metadata about the active project: root name, file count, total size, language stats.",
    "params": {}
  },
  {
    "name": "finish",
    "description": "Signal that the task is complete. Use when the user goal has been achieved and no further tool calls are needed.",
    "params": {
      "summary": {
        "type": "string",
        "required": true,
        "description": "Brief summary of what was accomplished"
      }
    }
  }
];

const TOOL_NAMES = TOOL_DEFINITIONS.map(t => t.name);

function buildToolSchemaBlock() {
  const lines = TOOL_DEFINITIONS.map(t => {
    const params = Object.entries(t.params).map(([k, v]) => {
      const req = v.required ? 'required' : 'optional';
      return '    - ' + k + ' (' + v.type + ', ' + req + '): ' + v.description;
    }).join('\n');
    return '  - ' + t.name + ': ' + t.description + '\n    Parameters:\n' + (params || '    (none)');
  }).join('\n');
  return lines;
}

const SYSTEM_PROMPT = [
  "You are Qwen Agent Studio - an autonomous coding agent operating inside the user's browser, on top of chat.qwen.ai.",
  "",
  "You have access to a real project workspace (browser OPFS storage) and a set of tools you can invoke to read, modify, search, and inspect the project files.",
  "",
  "# Available tools",
  "",
  buildToolSchemaBlock(),
  "",
  "# How to call a tool",
  "",
  "Whenever you need to perform an action, emit one or more tool calls using this exact XML syntax:",
  "",
  '<tool_call name=\"tool_name\">',
  '  <param_name>param value as raw text</param_name>',
  '  <other_param>...</other_param>',
  '</tool_call>',
  "",
  "Rules:",
  '- Always emit the FULL opening tag <tool_call name=\"...\"> on its own line.',
  '- Always close with </tool_call>.',
  '- Parameter values are the raw text between the opening and closing tags. Do NOT JSON-encode or HTML-escape them. Multi-line content is allowed.',
  '- You may include explanatory prose before/after tool calls; only the <tool_call>...</tool_call> blocks are executed.',
  '- After each tool call, stop generating and wait for the system to inject a <tool_result>...</tool_result> block. Then continue.',
  '- If a tool result is an error, fix your approach and retry.',
  '- Prefer batching independent tool calls (multiple <tool_call>...</tool_call> blocks in a single message) when there are no dependencies between them.',
  '- When the user goal is fully achieved, emit a <tool_call name=\"finish\"></tool_call> with a concise summary.',
  "",
  "# Behaviour",
  "",
  '- Always explore before editing: call list_dir / read_file / search_files to understand the project before making changes.',
  '- After making changes, briefly explain what you changed and why.',
  '- Be conservative: do not delete files unless explicitly asked.',
  '- For large files, prefer patch_file over write_file.',
  '- The workspace is sandboxed; absolute paths are not allowed. Always use paths relative to the project root.',
  '- All file paths use forward slashes, regardless of platform.',
  "",
  "# Project context",
  "",
  'The active project is provided in a separate <project_context>...</project_context> block at the start of the conversation. Use it for orientation.',
  "",
  "Remember: you are an agent. Act, do not just describe. Use the tools."
].join('\n');

const PROJECT_CONTEXT_TEMPLATE = (projectName, rootListing, stats) => {
  return [
    '<project_context>',
    '  <name>' + escapeXml(projectName) + '</name>',
    '  <file_count>' + stats.fileCount + '</file_count>',
    '  <total_bytes>' + stats.totalBytes + '</total_bytes>',
    '  <root_listing>',
    rootListing.map(e => '    ' + (e.type === 'dir' ? '[DIR] ' : '      ') + escapeXml(e.name) + (e.type === 'file' ? ' (' + e.size + ' bytes)' : '')).join('\n'),
    '  </root_listing>',
    '</project_context>'
  ].join('\n');
};

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOOL_CALL_REGEX = /<tool_call\s+name=["']([\w_]+)["']\s*>([\s\S]*?)<\/tool_call>/g;

function extractParam(body, name) {
  const re = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i');
  const m = body.match(re);
  if (!m) return undefined;
  let v = m[1];
  v = v.replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
  return v;
}

function parseToolCalls(text) {
  const calls = [];
  let m;
  TOOL_CALL_REGEX.lastIndex = 0;
  const seen = new Set();
  while ((m = TOOL_CALL_REGEX.exec(text)) !== null) {
    const name = m[1];
    const body = m[2];
    const key = name + '|' + body.length + '|' + body.slice(0, 32);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!TOOL_NAMES.includes(name)) {
      calls.push({ name: name, params: {}, error: 'Unknown tool: ' + name });
      continue;
    }
    const def = TOOL_DEFINITIONS.find(t => t.name === name);
    const params = {};
    let missing = null;
    for (const [k, v] of Object.entries(def.params)) {
      const val = extractParam(body, k);
      if (val === undefined && v.required) { missing = k; break; }
      if (val !== undefined) params[k] = val;
    }
    if (missing) {
      calls.push({ name: name, params: params, error: 'Missing required param: ' + missing });
      continue;
    }
    calls.push({ name: name, params: params });
  }
  return calls;
}

window.QwenStudio = window.QwenStudio || {};
window.QwenStudio.prompts = {
  TOOL_DEFINITIONS: TOOL_DEFINITIONS,
  TOOL_NAMES: TOOL_NAMES,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
  PROJECT_CONTEXT_TEMPLATE: PROJECT_CONTEXT_TEMPLATE,
  parseToolCalls: parseToolCalls,
  extractParam: extractParam,
  escapeXml: escapeXml,
  buildToolSchemaBlock: buildToolSchemaBlock
};
