/**
 * content.js —— 运行在隔离世界（ISOLATED world）的内容脚本。
 *
 * 职责：
 *   1. 接收 Service Worker 下发的任务，在目标页面上完成「填入文本 → 点击发送」；
 *   2. 自动探测响应容器（或在用户已配置选择器时直接使用），持续读取回答文本；
 *   3. 判定回答何时结束，并把增量与最终结果回传给 Service Worker。
 *
 * 设计约定：
 *   - 文本真相源是 DOM：不同站点的 SSE 结构千差万别，只有 DOM 是通用且可靠的；
 *   - 网络嗅探脚本（injected.js）只提供「有数据流动 / 流已结束」两类信号，用于加速结束判定；
 *   - 轮询与结束判定全部放在 content script 中完成，避免 Service Worker 休眠导致状态丢失。
 */
(function () {
  'use strict';

  /** 轮询与结束判定的默认参数（单位：毫秒） */
  var CFG = {
    pollMs: 400,          // DOM 轮询间隔
    stableAfterNetMs: 1500, // 收到流结束信号后，要求 DOM 静止多久才算完成
    stableDomOnlyMs: 6000,  // 未收到网络信号时，要求 DOM 静止多久才算完成
    startGraceMs: 3000,     // 任务开始后的最短观察时间，防止过早收尾
    elementTimeoutMs: 15000, // 等待输入框/发送按钮出现的上限
    snapshotDelayMs: 300     // 点击发送后，等待新消息容器渲染的时间
  };

  /** 当前正在执行的任务；为 null 表示空闲 */
  var job = null;
  /** 与 Service Worker 的持久连接 */
  var port = null;
  /** 已累计监听到的网络文本长度，仅用于日志诊断 */
  var netTextLength = 0;

  // ------------------------------------------------------------------ 基础工具

  /**
   * 等待指定毫秒。
   * @param {number} ms 等待时长
   * @returns {Promise<void>} 计时结束后 resolve
   */
  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 向 Service Worker 上报消息（优先走持久连接，失败时退回一次性消息）。
   * @param {Object} payload 消息内容
   */
  function report(payload) {
    if (port) {
      try {
        port.postMessage(payload);
        return;
      } catch (err) {
        port = null;
      }
    }
    try {
      chrome.runtime.sendMessage(payload);
    } catch (err) {
      // 扩展上下文失效（如扩展被卸载/重载），忽略即可
    }
  }

  /**
   * 上报一段调试日志。
   * @param {string} message 日志文本
   * @param {string} [level] 日志级别
   */
  function log(message, level) {
    report({ action: 'log', level: level || 'info', message: '[content] ' + message });
  }

  // ------------------------------------------------------------------ 元素查找

  /**
   * 等待某个选择器对应的元素出现。
   * @param {string} selector CSS 选择器
   * @param {number} timeout 最长等待时间（毫秒）
   * @returns {Promise<Element|null>} 找到的元素，超时返回 null
   */
  function waitForElement(selector, timeout) {
    if (!selector) {
      return Promise.resolve(null);
    }
    var deadline = Date.now() + timeout;
    return new Promise(function (resolve) {
      function attempt() {
        var el = null;
        try {
          el = document.querySelector(selector);
        } catch (err) {
          resolve(null); // 选择器非法
          return;
        }
        if (el) {
          resolve(el);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        setTimeout(attempt, 200);
      }
      attempt();
    });
  }

  /**
   * 判断元素是否可见。
   * @param {Element} el 待判断元素
   * @returns {boolean} 可见返回 true
   */
  function isVisible(el) {
    if (!el || !el.getClientRects || el.getClientRects().length === 0) {
      return false;
    }
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    if (parseFloat(style.opacity) === 0) {
      return false;
    }
    return true;
  }

  /**
   * 读取元素内文本。
   * @param {Element} el 目标元素
   * @returns {string} 归一化后的文本
   */
  function readText(el) {
    if (!el) {
      return '';
    }
    var text = typeof el.innerText === 'string' && el.innerText.trim()
      ? el.innerText
      : (el.textContent || '');
    return text.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
  }

  // ------------------------------------------------------------------ 输入写入

  /**
   * 自动识别页面上的主输入框，作为未配置选择器时的兜底。
   *
   * 策略：在可见、可编辑的候选元素中，取面积最大者；面积相同时取更靠下的一个
   * （聊天输入框通常位于页面底部）。
   *
   * @returns {Element|null} 命中的输入框，未找到返回 null
   */
  function autoDetectInput() {
    var nodes = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]');
    var candidates = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!isVisible(el) || el.disabled || el.readOnly) {
        continue;
      }
      var rect = el.getBoundingClientRect();
      candidates.push({ el: el, area: rect.width * rect.height, top: rect.top });
    }
    if (candidates.length === 0) {
      return null;
    }
    candidates.sort(function (a, b) {
      if (b.area !== a.area) {
        return b.area - a.area;
      }
      return b.top - a.top;
    });
    return candidates[0].el;
  }

  /**
   * 沿原型链查找某个属性的原生 setter，绕过页面（如 React）对实例属性的改写。
   * @param {Element} el 目标元素
   * @param {string} prop 属性名
   * @returns {Function|null} 原生 setter，未找到返回 null
   */
  function getNativeSetter(el, prop) {
    var proto = Object.getPrototypeOf(el);
    while (proto) {
      var desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.set) {
        return desc.set;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  /**
   * 向 input / textarea 写入文本，并触发框架可感知的输入事件。
   * @param {Element} el 输入框
   * @param {string} text 待写入文本
   * @returns {boolean} 写入后值一致返回 true
   */
  function setNativeValue(el, text) {
    var setter = getNativeSetter(el, 'value');
    if (!setter) {
      return false;
    }
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
    // 先把光标移到末尾，避免受控组件重渲染后光标跳回开头
    if (typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch (err) {
        // number 等类型的输入框不支持 setSelectionRange，忽略
      }
    }
    setter.call(el, text);
    // React 在根容器上以事件委托方式监听 input，必须允许冒泡
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === text;
  }

  /**
   * 通过模拟粘贴把文本写入 contenteditable 编辑器（如 ProseMirror）。
   * @param {Element} el 可编辑元素
   * @param {string} text 待写入文本
   * @returns {boolean} 事件未被阻止（说明编辑器已处理）返回 true
   */
  function insertViaPaste(el, text) {
    var dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);

    var event;
    try {
      event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dataTransfer
      });
    } catch (err) {
      event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    }

    el.focus();
    // 编辑器处理成功后会调用 preventDefault，dispatchEvent 返回 false
    return el.dispatchEvent(event) === false;
  }

  /**
   * 使用 execCommand 兜底写入（Chrome 仍保留该能力）。
   * @param {Element} el 可编辑元素
   * @param {string} text 待写入文本
   * @returns {boolean} 执行成功返回 true
   */
  function insertViaExecCommand(el, text) {
    try {
      el.focus();
      var selection = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return document.execCommand('insertText', false, text);
    } catch (err) {
      return false;
    }
  }

  /**
   * 把文本写入目标元素，自动适配 input/textarea 与 contenteditable。
   * @param {Element} el 目标元素
   * @param {string} text 待写入文本
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function writeText(el, text) {
    var tag = (el.tagName || '').toLowerCase();
    if (el.isContentEditable) {
      if (insertViaPaste(el, text)) {
        return true;
      }
      if (insertViaExecCommand(el, text)) {
        return true;
      }
      // 最后兜底：直接改文本并派发输入事件
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      await sleep(80);
      return readText(el).length > 0;
    }
    if (tag === 'input' || tag === 'textarea') {
      var ok = setNativeValue(el, text);
      await sleep(80);
      return ok || el.value === text;
    }
    // 其他非可编辑元素：尝试按可编辑方式处理
    el.focus();
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    if (insertViaPaste(el, text)) {
      return true;
    }
    return insertViaExecCommand(el, text);
  }

  /**
   * 点击元素（优先原生 click，必要时补发鼠标事件序列）。
   * @param {Element} el 目标元素
   * @returns {boolean} 是否完成点击
   */
  function clickElement(el) {
    if (!el) {
      return false;
    }
    try {
      el.scrollIntoView({ block: 'center' });
    } catch (err) {
      // 滚动失败不影响点击
    }
    try {
      el.click();
      return true;
    } catch (err) {
      var event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window });
      el.dispatchEvent(event);
      return true;
    }
  }

  /**
   * 在输入框中模拟按下 Enter。
   * @param {Element} el 输入框
   */
  function pressEnter(el) {
    el.focus();
    var options = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', options));
    el.dispatchEvent(new KeyboardEvent('keypress', options));
    el.dispatchEvent(new KeyboardEvent('keyup', options));
  }

  // -------------------------------------------------------- 响应容器自动探测

  /**
   * 收集页面中所有可作为响应容器的候选元素。
   * @returns {Element[]} 候选元素列表
   */
  function collectCandidates() {
    var result = [];
    var rejectTags = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, PATH: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, IMG: 1, VIDEO: 1, AUDIO: 1 };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (node) {
        if (rejectTags[node.tagName]) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node = walker.nextNode();
    while (node) {
      result.push(node);
      node = walker.nextNode();
    }
    return result;
  }

  /**
   * 对页面做一次文本长度快照，用于后续计算增量。
   * @returns {Map<Element, number>} 元素到文本长度的映射
   */
  function snapshotLengths() {
    var snapshot = new Map();
    var candidates = collectCandidates();
    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (!isVisible(el)) {
        continue;
      }
      snapshot.set(el, readText(el).length);
    }
    return snapshot;
  }

  /**
   * 依据文本增量自动挑选最可能的响应容器。
   *
   * 策略：
   *   1. 只考虑可见、非输入框、且文本有增长的元素；
   *   2. 若某元素的某个后代贡献了几乎全部增量，则该元素是「祖先容器」，予以排除，
   *      从而选中粒度最细、最贴近真实回答的那个节点；
   *   3. 在剩余元素中取增量最大者。
   *
   * @param {Map<Element, number>} snapshot 发送前（或上一轮）的文本长度快照
   * @returns {Element|null} 命中的响应容器，未产生任何增量时返回 null
   */
  function pickResponseElement(snapshot) {
    var candidates = collectCandidates();
    var grown = [];

    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (!isVisible(el)) {
        continue;
      }
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
        continue;
      }
      var length = readText(el).length;
      var previous = snapshot.has(el) ? snapshot.get(el) : 0;
      var delta = length - previous;
      if (delta > 0) {
        grown.push({ el: el, delta: delta, length: length });
      }
    }

    if (grown.length === 0) {
      return null;
    }

    var filtered = [];
    for (var a = 0; a < grown.length; a += 1) {
      var current = grown[a];
      var isAncestor = false;
      for (var b = 0; b < grown.length; b += 1) {
        if (a === b) {
          continue;
        }
        var other = grown[b];
        if (current.el !== other.el && current.el.contains(other.el) && other.delta >= current.delta * 0.95) {
          isAncestor = true;
          break;
        }
      }
      if (!isAncestor) {
        filtered.push(current);
      }
    }

    var list = filtered.length > 0 ? filtered : grown;
    list.sort(function (x, y) {
      if (y.delta !== x.delta) {
        return y.delta - x.delta;
      }
      return x.length - y.length; // 增量相同时取更短（更精确）的容器
    });
    return list[0].el;
  }

  // ------------------------------------------------------------------ 任务执行

  /**
   * 结束当前任务并上报最终结果。
   * @param {string} finishReason 结束原因
   */
  function finishJob(finishReason) {
    if (!job) {
      return;
    }
    var current = job;
    job = null;
    if (current.timer) {
      clearInterval(current.timer);
    }
    window.postMessage({ __oap: 'OAP_NET_CHANNEL', type: 'disarm' }, '*');
    report({
      action: 'done',
      requestId: current.requestId,
      text: current.lastText,
      finishReason: finishReason
    });
  }

  /**
   * 结束当前任务并上报错误。
   * @param {string} code 错误码
   * @param {string} message 错误描述
   */
  function failJob(code, message) {
    if (!job) {
      return;
    }
    var current = job;
    job = null;
    if (current.timer) {
      clearInterval(current.timer);
    }
    window.postMessage({ __oap: 'OAP_NET_CHANNEL', type: 'disarm' }, '*');
    report({ action: 'error', requestId: current.requestId, code: code, message: message });
  }

  /**
   * 每一轮轮询：读取文本、上报增量、判定是否结束。
   */
  function tick() {
    if (!job) {
      return;
    }
    var now = Date.now();
    var elapsed = now - job.startedAt;

    var element = null;
    if (job.profile.responseSelector) {
      try {
        element = document.querySelector(job.profile.responseSelector);
      } catch (err) {
        element = null;
      }
    }
    if (!element) {
      element = pickResponseElement(job.snapshot);
    }

    var text = readText(element);
    if (text && text !== job.lastText) {
      // DOM 是累积文本，通常只需取新增部分；若发生重排则整段替换
      var delta = text.indexOf(job.lastText) === 0 ? text.slice(job.lastText.length) : text;
      job.lastText = text;
      job.lastChangeAt = now;
      job.hasContent = true;
      if (delta) {
        report({ action: 'chunk', requestId: job.requestId, text: delta });
      }
    }

    var stableFor = now - job.lastChangeAt;
    var waitTime = job.netDone ? CFG.stableAfterNetMs : CFG.stableDomOnlyMs;

    if (job.hasContent && stableFor >= waitTime && elapsed >= CFG.startGraceMs) {
      finishJob('stop');
      return;
    }
    if (job.netDone && job.hasContent && stableFor >= CFG.stableAfterNetMs) {
      finishJob('stop');
      return;
    }
    if (elapsed >= job.timeoutMs) {
      if (job.hasContent) {
        finishJob('length');
      } else {
        failJob('no_response', '未在超时时间内检测到回答内容，请检查输入框/发送按钮选择器，或手动配置响应容器选择器');
      }
    }
  }

  /**
   * 执行一次完整的对话任务。
   * @param {Object} payload 任务参数
   */
  async function runJob(payload) {
    var requestId = payload.requestId;
    var profile = payload.profile || {};

    if (job) {
      report({ action: 'error', requestId: requestId, code: 'busy', message: '当前页面已有任务在执行' });
      return;
    }
    var input = null;
    if (profile.inputSelector) {
      input = await waitForElement(profile.inputSelector, CFG.elementTimeoutMs);
      if (!input) {
        report({
          action: 'error',
          requestId: requestId,
          code: 'element_timeout',
          message: '未找到输入框元素：' + profile.inputSelector
        });
        return;
      }
    } else {
      input = autoDetectInput();
      if (!input) {
        report({
          action: 'error',
          requestId: requestId,
          code: 'selector_missing',
          message: '未能自动识别输入框，请在扩展弹窗中配置该站点的输入框选择器'
        });
        return;
      }
      log('未配置输入框选择器，已自动识别：' + (input.tagName || '').toLowerCase());
    }

    var written = await writeText(input, payload.prompt || '');
    if (!written) {
      log('文本写入后校验未通过，仍继续尝试发送', 'warn');
    }

    // 开启网络嗅探，用于加速结束判定
    window.postMessage(
      {
        __oap: 'OAP_NET_CHANNEL',
        type: 'arm',
        urlPattern: profile.responseUrlPattern || '',
        withText: false
      },
      '*'
    );
    netTextLength = 0;

    await sleep(150);

    if (profile.sendSelector) {
      var button = await waitForElement(profile.sendSelector, 5000);
      if (!button) {
        window.postMessage({ __oap: 'OAP_NET_CHANNEL', type: 'disarm' }, '*');
        report({
          action: 'error',
          requestId: requestId,
          code: 'element_timeout',
          message: '未找到发送按钮元素：' + profile.sendSelector
        });
        return;
      }
      clickElement(button);
    } else {
      pressEnter(input);
    }

    await sleep(CFG.snapshotDelayMs);

    job = {
      requestId: requestId,
      profile: profile,
      startedAt: Date.now(),
      lastChangeAt: Date.now(),
      timeoutMs: payload.timeoutMs || 180000,
      snapshot: snapshotLengths(),
      lastText: '',
      hasContent: false,
      netDone: false,
      signalReported: false,
      timer: null
    };

    report({ action: 'accepted', requestId: requestId });
    job.timer = setInterval(tick, CFG.pollMs);
  }

  /**
   * 处理网络嗅探脚本回传的信号。
   * @param {Object} data 消息内容
   */
  function handleNetMessage(data) {
    if (!job) {
      return;
    }
    if (data.type === 'net_text') {
      // 网络文本在 MVP 阶段仅用于诊断统计，不作为文本源，故不上报以免产生高频消息
      if (typeof data.text === 'string') {
        netTextLength += data.text.length;
      }
      return;
    }
    if (data.type === 'net_signal') {
      // 每个任务只上报一次：仅需让 Service Worker 知道网络通道有效，从而取消 debugger 降级
      if (!job.signalReported) {
        job.signalReported = true;
        report({ action: 'net_signal', requestId: job.requestId, source: 'page' });
      }
      return;
    }
    if (data.type === 'net_done') {
      job.netDone = true;
      report({ action: 'net_done', requestId: job.requestId });
      return;
    }
    if (data.type === 'net_error') {
      job.netDone = true; // 嗅探失败时直接交给 DOM 稳定判定兜底
      report({ action: 'net_done', requestId: job.requestId });
    }
  }

  // ------------------------------------------------------------------ 消息通道

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.__oap !== 'OAP_NET_CHANNEL') {
      return;
    }
    handleNetMessage(event.data);
  });

  function handleCommand(message) {
    if (!message || !message.action) {
      return;
    }
    if (message.action === 'run') {
      runJob(message);
      return;
    }
    if (message.action === 'cancel') {
      if (job) {
        failJob('cancelled', '任务已被取消');
      }
      return;
    }
    // Service Worker 通过 debugger 通道捕获到的网络信号，作用与页面内嗅探一致
    if (message.action === 'net_signal_external') {
      if (job) {
        report({ action: 'net_signal', requestId: job.requestId, length: netTextLength, source: 'debugger' });
      }
      return;
    }
    if (message.action === 'net_done_external') {
      if (job && !job.netDone) {
        job.netDone = true;
        report({ action: 'net_done', requestId: job.requestId, source: 'debugger' });
      }
      return;
    }
    if (message.action === 'ping') {
      report({ action: 'pong', busy: job !== null });
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // ping 用于 Service Worker 探测 content script 是否已注入，必须同步回执
    if (message && message.action === 'ping') {
      sendResponse({ ok: true, busy: job !== null });
      return true;
    }
    handleCommand(message);
    return false;
  });

  /**
   * 建立与 Service Worker 的持久连接，断开后自动重连。
   */
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'oap-content' });
    } catch (err) {
      setTimeout(connectPort, 2000);
      return;
    }
    port.onMessage.addListener(function (message) {
      handleCommand(message);
    });
    port.onDisconnect.addListener(function () {
      port = null;
      setTimeout(connectPort, 2000);
    });
  }

  connectPort();
  // 页面加载完成后主动上报，便于 Service Worker 维护标签页清单
  report({ action: 'hello', url: window.location.href, title: document.title });
})();
