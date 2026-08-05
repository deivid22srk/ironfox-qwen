/* Qwen Agent Studio - Content script (injetado em chat.qwen.ai)
 *
 * Responsabilidades:
 *   1. Detectar o textarea / input de chat do Qwen e interceptar envios
 *   2. Antes de enviar, injetar o system prompt + project context
 *   3. Observar as respostas do Qwen, detectar tool_calls (<tool_call name=...>)
 *   4. Executar tools via o background service worker
 *   5. Inserir o resultado como nova mensagem de "user" contendo <tool_result>
 *      para o Qwen continuar a geração
 *   6. Renderizar uma UI lateral (sidebar) estilo VS Code/Opencode com:
 *        - File tree do projeto ativo
 *        - Console de tool calls
 *        - Botão "New Project" / "Open Project"
 *   7. Adicionar um botão flutuante para abrir/fechar a sidebar
 *
 * Notas sobre a DOM do chat.qwen.ai:
 *   A DOM é uma SPA React (qwen-chat-fe). Os seletores abaixo foram
 *   escritos para serem resilientes: usamos atributos data-* quando
 *   disponíveis, fallback para [contenteditable], textarea, etc.
 *   Se a UI mudar, basta ajustar as funções findChatInput() e
 *   findSendButton().
 */

(function () {
  'use strict';

  // Evita dupla injeção
  if (window.__QWEN_STUDIO_LOADED__) return;
  window.__QWEN_STUDIO_LOADED__ = true;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const log = (...args) => console.log('[QwenStudio]', ...args);
  const warn = (...args) => console.warn('[QwenStudio]', ...args);

  // ========================================================================
  // Estado local
  // ========================================================================

  const local = {
    sidebarEl: null,
    floatingBtn: null,
    observer: null,
    sendInterceptorInstalled: false,
    activeProject: null,
    toolCallCount: 0,
    isProcessingTool: false
  };

  // ========================================================================
  // Comunicação com background
  // ========================================================================

  function bg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    });
  }

  async function refreshActiveProject() {
    const r = await bg({ type: 'GET_STATE' });
    if (r.ok) {
      local.activeProject = r.state.activeProject;
      return r.state;
    }
    return null;
  }

  // ========================================================================
  // Detecção da DOM do Qwen
  // ========================================================================

  function findChatInput() {
    // Ordem de preferência: contenteditable explícito > textarea > div editável
    const candidates = [
      ...$$('[contenteditable="true"]'),
      ...$$('textarea'),
    ];
    // Filtra os visíveis
    return candidates.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 50 && r.height > 20;
    }) || null;
  }

  function findSendButton() {
    // Procura por botões com aria-label contendo "send" ou "submit",
    // ou SVG icon button adjacente ao input.
    const btns = $$('button, [role="button"]');
    for (const b of btns) {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      const title = (b.getAttribute('title') || '').toLowerCase();
      if (aria.includes('send') || title.includes('send') ||
          aria.includes('enviar') || title.includes('enviar')) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return b;
      }
    }
    // Fallback: botão dentro do mesmo form/container do input
    const input = findChatInput();
    if (input) {
      const container = input.closest('form, [class*="input"], [class*="chat"]');
      if (container) {
        const b = container.querySelector('button[type="submit"], button:last-of-type');
        if (b) return b;
      }
    }
    return null;
  }

  function findMessagesContainer() {
    // Tenta seletores comuns da SPA do Qwen
    const candidates = [
      $('[class*="message-list"]'),
      $('[class*="conversation"]'),
      $('[class*="chat-content"]'),
      $('main [role="log"]'),
      $('main')
    ];
    return candidates.find(el => el) || null;
  }

  function findLastAssistantMessage() {
    // Heurística: último filho do container de mensagens cujo texto não é do user.
    const container = findMessagesContainer();
    if (!container) return null;
    const items = $$('[class*="message"], [class*="bubble"], [class*="assistant"]', container);
    return items[items.length - 1] || null;
  }

  function getLatestAssistantText() {
    const msg = findLastAssistantMessage();
    if (!msg) return '';
    return msg.innerText || msg.textContent || '';
  }

  // ========================================================================
  // Injeção de texto no input do Qwen
  // ========================================================================

  function setInputValue(el, value) {
    // Dispara eventos que React respeita para contenteditable e textarea.
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      // Select all + delete, then paste
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, value);
    }
  }

  function appendToInput(el, value) {
    const cur = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
      ? el.value
      : el.innerText;
    setInputValue(el, cur + value);
  }

  function clickSend() {
    const btn = findSendButton();
    if (btn) {
      btn.click();
      return true;
    }
    // Fallback: Enter no input
    const input = findChatInput();
    if (input) {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }));
      return true;
    }
    return false;
  }

  // ========================================================================
  // Construção do prompt do sistema
  // ========================================================================

  async function buildPrefixForUserMessage(userText) {
    const state = await refreshActiveProject();
    if (!state || !state.activeProject) {
      // Sem projeto ativo: ainda assim instrui o modelo sobre as tools.
      return {
        prefix: '',
        wrapped: userText
      };
    }
    // Busca contexto do projeto
    const ctx = await bg({ type: 'GET_PROJECT_CONTEXT' });
    let projectBlock = '';
    if (ctx.ok) {
      const { name, rootListing, stats } = ctx.context;
      projectBlock = window.QwenStudio.prompts.PROJECT_CONTEXT_TEMPLATE(name, rootListing, stats);
    }
    const systemPrompt = window.QwenStudio.prompts.SYSTEM_PROMPT;
    // O Qwen não tem API "system" exposta na web; embutimos o system prompt
    // como a primeira "instrução" invisível para o modelo, seguida da pergunta do user.
    const prefix = `${systemPrompt}\n\n${projectBlock}\n\n# User request\n\n`;
    return { prefix, wrapped: prefix + userText };
  }

  // ========================================================================
  // Interceptação de envio de mensagem
  // ========================================================================

  function installSendInterceptor() {
    if (local.sendInterceptorInstalled) return;
    // Estratégia: capturar Enter (sem shift) no input, e capturar click no botão send.
    const tryHook = () => {
      const input = findChatInput();
      const sendBtn = findSendButton();
      if (input && !input.__qsHooked) {
        input.__qsHooked = true;
        input.addEventListener('keydown', async (e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
          // Verifica se há texto
          const txt = (input.tagName === 'TEXTAREA' ? input.value : input.innerText).trim();
          if (!txt) return;
          // Se já estamos processando tool, não interferir
          if (local.isProcessingTool) return;
          // Prepend system prompt + project context
          e.preventDefault();
          e.stopPropagation();
          await sendMessageWithAgentPrefix(txt);
        }, true);
      }
      if (sendBtn && !sendBtn.__qsHooked) {
        sendBtn.__qsHooked = true;
        sendBtn.addEventListener('click', async (e) => {
          const input = findChatInput();
          if (!input) return;
          const txt = (input.tagName === 'TEXTAREA' ? input.value : input.innerText).trim();
          if (!txt) return;
          if (local.isProcessingTool) return;
          e.preventDefault();
          e.stopPropagation();
          await sendMessageWithAgentPrefix(txt);
        }, true);
      }
    };
    // Hook agora e novamente a cada mutação (a SPA pode recriar elementos)
    tryHook();
    const mo = new MutationObserver(() => tryHook());
    mo.observe(document.body, { childList: true, subtree: true });
    local.observer = mo;
    local.sendInterceptorInstalled = true;
  }

  async function sendMessageWithAgentPrefix(userText) {
    const input = findChatInput();
    if (!input) {
      warn('No chat input found');
      return;
    }
    const { wrapped } = await buildPrefixForUserMessage(userText);
    setInputValue(input, wrapped);
    // Pequeno delay para o React atualizar estado interno
    await new Promise(r => setTimeout(r, 50));
    clickSend();
    // Limpa o input de qualquer resquício
    setTimeout(() => {
      try { setInputValue(input, ''); } catch {}
    }, 200);
    // Começa a observar a resposta
    startWatchingAssistantResponse();
  }

  // ========================================================================
  // Detecção e execução de tool calls na resposta do assistente
  // ========================================================================

  function startWatchingAssistantResponse() {
    const container = findMessagesContainer();
    if (!container) return;
    let lastText = '';
    let stableTicks = 0;
    const interval = setInterval(async () => {
      const text = getLatestAssistantText();
      if (text === lastText) {
        stableTicks++;
        // Considera "estável" após ~2.5s sem mudança
        if (stableTicks === 5) {
          await maybeHandleToolCalls(text);
        }
      } else {
        stableTicks = 0;
        lastText = text;
      }
      // Cancela após 5min
      if (stableTicks > 60) {
        clearInterval(interval);
      }
    }, 500);
  }

  async function maybeHandleToolCalls(text) {
    if (local.isProcessingTool) return;
    const calls = window.QwenStudio.prompts.parseToolCalls(text);
    if (calls.length === 0) return;
    local.isProcessingTool = true;
    try {
      log(`Detected ${calls.length} tool call(s)`, calls);
      // Renderiza na sidebar
      appendToolCallLog(calls);
      // Executa em paralelo se forem independentes; em sequência se dependentes.
      // Heurística simples: se houver finish, executa por último; demais em paralelo.
      const results = [];
      const finishCalls = calls.filter(c => c.name === 'finish');
      const otherCalls = calls.filter(c => c.name !== 'finish');
      const otherResults = await Promise.all(otherCalls.map(async c => {
        const r = await bg({ type: 'EXECUTE_TOOL', call: c });
        return { call: c, result: r.result };
      }));
      results.push(...otherResults);
      if (finishCalls.length) {
        for (const c of finishCalls) {
          const r = await bg({ type: 'EXECUTE_TOOL', call: c });
          results.push({ call: c, result: r.result });
        }
      }
      // Renderiza resultados
      appendToolResultLog(results);
      // Verifica se algum foi finish
      const finish = results.find(r => r.call.name === 'finish');
      if (finish) {
        log('Agent finished:', finish.result?.result?.summary || '');
        local.isProcessingTool = false;
        return;
      }
      // Constrói mensagem de tool_result para o Qwen continuar
      const resultText = buildToolResultMessage(results);
      // Envia como nova mensagem de usuário (continuação do agente)
      await sendToolResults(resultText);
    } catch (e) {
      warn('Tool handling error:', e);
    } finally {
      local.isProcessingTool = false;
    }
  }

  function buildToolResultMessage(results) {
    const blocks = results.map(({ call, result }) => {
      const status = result.ok ? 'ok' : 'error';
      const payload = result.ok
        ? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2))
        : result.error;
      return `<tool_result name="${call.name}" status="${status}">\n${payload}\n</tool_result>`;
    }).join('\n\n');
    return `${blocks}\n\n# Continuation\n\nThe above tool results are now available. Continue the task: if you have enough information to respond to the user, do so. Otherwise, emit more <tool_call> blocks as needed. Remember to emit <tool_call name="finish"> when the user's goal has been fully achieved.`;
  }

  async function sendToolResults(text) {
    const input = findChatInput();
    if (!input) return;
    setInputValue(input, text);
    await new Promise(r => setTimeout(r, 80));
    clickSend();
    setTimeout(() => {
      try { setInputValue(input, ''); } catch {}
    }, 200);
    // Continua observando a próxima resposta
    startWatchingAssistantResponse();
  }

  // ========================================================================
  // UI: Sidebar
  // ========================================================================

  function ensureSidebar() {
    if (local.sidebarEl) return local.sidebarEl;
    const el = document.createElement('div');
    el.id = 'qwen-studio-sidebar';
    el.innerHTML = `
      <div class="qs-header">
        <div class="qs-title">
          <span class="qs-logo">◆</span>
          <span>Qwen Agent Studio</span>
        </div>
        <div class="qs-actions">
          <button class="qs-btn-icon" data-act="refresh" title="Refresh file tree">↻</button>
          <button class="qs-btn-icon" data-act="export" title="Export project (JSON)">⤓</button>
          <button class="qs-btn-icon" data-act="close" title="Close sidebar">✕</button>
        </div>
      </div>
      <div class="qs-section qs-projects">
        <div class="qs-section-title">Project</div>
        <div class="qs-project-row">
          <select class="qs-project-select"></select>
          <button class="qs-btn" data-act="new">New</button>
          <button class="qs-btn" data-act="open">Open</button>
        </div>
      </div>
      <div class="qs-section qs-files">
        <div class="qs-section-title">Files</div>
        <div class="qs-tree"></div>
      </div>
      <div class="qs-section qs-terminal">
        <div class="qs-section-title">Tool calls</div>
        <div class="qs-console"></div>
      </div>
    `;
    document.body.appendChild(el);
    local.sidebarEl = el;

    // Eventos
    el.querySelector('[data-act="close"]').addEventListener('click', () => toggleSidebar(false));
    el.querySelector('[data-act="refresh"]').addEventListener('click', () => refreshFileTree());
    el.querySelector('[data-act="export"]').addEventListener('click', () => bg({ type: 'EXPORT_PROJECT' }));
    el.querySelector('[data-act="new"]').addEventListener('click', async () => {
      const name = prompt('New project name:');
      if (!name) return;
      const r = await bg({ type: 'CREATE_PROJECT', name });
      if (r.ok) {
        await refreshProjectSelect();
        await refreshFileTree();
      } else {
        alert('Error: ' + r.error);
      }
    });
    el.querySelector('[data-act="open"]').addEventListener('click', async () => {
      const sel = el.querySelector('.qs-project-select');
      const name = sel.value;
      if (!name) return;
      const r = await bg({ type: 'SELECT_PROJECT', name });
      if (r.ok) {
        local.activeProject = name;
        await refreshFileTree();
      } else {
        alert('Error: ' + r.error);
      }
    });
    el.querySelector('.qs-project-select').addEventListener('change', async (e) => {
      const name = e.target.value;
      if (!name) return;
      const r = await bg({ type: 'SELECT_PROJECT', name });
      if (r.ok) {
        local.activeProject = name;
        await refreshFileTree();
      }
    });

    return el;
  }

  function ensureFloatingButton() {
    if (local.floatingBtn) return local.floatingBtn;
    const btn = document.createElement('button');
    btn.id = 'qwen-studio-fab';
    btn.title = 'Qwen Agent Studio';
    btn.innerHTML = '◆';
    btn.addEventListener('click', () => toggleSidebar());
    document.body.appendChild(btn);
    local.floatingBtn = btn;
    return btn;
  }

  async function toggleSidebar(force) {
    const el = ensureSidebar();
    const fab = ensureFloatingButton();
    const shouldShow = force === undefined ? !el.classList.contains('qs-open') : force;
    if (shouldShow) {
      el.classList.add('qs-open');
      fab.classList.add('qs-hidden');
      await refreshProjectSelect();
      await refreshFileTree();
    } else {
      el.classList.remove('qs-open');
      fab.classList.remove('qs-hidden');
    }
  }

  async function refreshProjectSelect() {
    const el = ensureSidebar();
    const sel = el.querySelector('.qs-project-select');
    const r = await bg({ type: 'LIST_PROJECTS' });
    if (!r.ok) return;
    const projects = r.projects || [];
    const state = await refreshActiveProject();
    const active = state ? state.activeProject : null;
    sel.innerHTML = projects.length === 0
      ? '<option value="">(no projects)</option>'
      : projects.map(p => `<option value="${p.name}" ${p.name === active ? 'selected' : ''}>${p.name}</option>`).join('');
  }

  async function refreshFileTree() {
    const el = ensureSidebar();
    const treeEl = el.querySelector('.qs-tree');
    const state = await refreshActiveProject();
    if (!state || !state.activeProject) {
      treeEl.innerHTML = '<div class="qs-empty">No active project. Click "New" to create one.</div>';
      return;
    }
    treeEl.innerHTML = '<div class="qs-loading">Loading…</div>';
    const r = await bg({ type: 'GET_FILE_TREE' });
    if (!r.ok) {
      treeEl.innerHTML = '<div class="qs-error">' + escapeHtml(r.error) + '</div>';
      return;
    }
    treeEl.innerHTML = '';
    renderTreeNode(r.tree, treeEl, 0);
  }

  function renderTreeNode(node, parent, depth) {
    if (node.type === 'file') {
      const row = document.createElement('div');
      row.className = 'qs-tree-file';
      row.style.paddingLeft = (8 + depth * 14) + 'px';
      row.innerHTML = `<span class="qs-tree-icon">📄</span> ${escapeHtml(node.name)}`;
      row.title = `${node.name} (${node.size} bytes)`;
      parent.appendChild(row);
    } else {
      const dir = document.createElement('div');
      dir.className = 'qs-tree-dir';
      const header = document.createElement('div');
      header.className = 'qs-tree-dir-header';
      header.style.paddingLeft = (8 + depth * 14) + 'px';
      header.innerHTML = `<span class="qs-tree-icon">📁</span> ${escapeHtml(node.name)}`;
      parent.appendChild(header);
      const childrenWrap = document.createElement('div');
      parent.appendChild(childrenWrap);
      header.addEventListener('click', () => {
        childrenWrap.classList.toggle('qs-collapsed');
        header.classList.toggle('qs-collapsed');
      });
      for (const child of node.children || []) {
        renderTreeNode(child, childrenWrap, depth + 1);
      }
    }
  }

  function appendToolCallLog(calls) {
    const el = ensureSidebar();
    const console = el.querySelector('.qs-console');
    for (const c of calls) {
      const row = document.createElement('div');
      row.className = 'qs-tool-call';
      const params = Object.entries(c.params || {})
        .map(([k, v]) => `<div class="qs-param"><span class="qs-key">${escapeHtml(k)}:</span> <span class="qs-val">${escapeHtml(truncate(v, 80))}</span></div>`)
        .join('');
      row.innerHTML = `
        <div class="qs-tool-header">
          <span class="qs-tool-name">${escapeHtml(c.name)}</span>
          ${c.error ? '<span class="qs-tool-error">' + escapeHtml(c.error) + '</span>' : ''}
          <span class="qs-tool-status qs-pending">pending</span>
        </div>
        <div class="qs-params">${params}</div>
        <div class="qs-result"></div>
      `;
      console.appendChild(row);
      c.__rowEl = row;
      console.scrollTop = console.scrollHeight;
    }
  }

  function appendToolResultLog(results) {
    const el = ensureSidebar();
    const console = el.querySelector('.qs-console');
    for (const r of results) {
      const row = r.call.__rowEl;
      if (!row) continue;
      const status = row.querySelector('.qs-tool-status');
      status.classList.remove('qs-pending');
      status.classList.add(r.result.ok ? 'qs-ok' : 'qs-fail');
      status.textContent = r.result.ok ? 'ok' : 'fail';
      const resultEl = row.querySelector('.qs-result');
      const txt = r.result.ok
        ? (typeof r.result.result === 'string' ? r.result.result : JSON.stringify(r.result.result, null, 2))
        : r.result.error;
      resultEl.innerHTML = `<pre>${escapeHtml(truncate(txt, 2000))}</pre>`;
    }
    console.scrollTop = console.scrollHeight;
    // Após atualizar arquivos, atualiza tree
    refreshFileTree();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function truncate(s, n) {
    if (s == null) return '';
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ========================================================================
  // Inicialização
  // ========================================================================

  function init() {
    log('Initializing Qwen Agent Studio content script');
    installSendInterceptor();
    ensureFloatingButton();
    // Tenta abrir sidebar automaticamente se houver projeto ativo
    refreshActiveProject().then(state => {
      if (state && state.activeProject) {
        toggleSidebar(true);
      }
    });
    // Reinstala interceptador a cada 3s nos primeiros 30s (SPA pode demorar a estabilizar)
    let ticks = 0;
    const rehookInterval = setInterval(() => {
      installSendInterceptor();
      ticks++;
      if (ticks > 10) clearInterval(rehookInterval);
    }, 3000);
  }

  // Inicia quando o DOM estiver estável
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 500);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
  }
})();
