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

  /** 轮询与结束判定的默认参数（单位：毫秒 / 次） */
  var CFG = {
    pollMs: 400,            // DOM 轮询间隔
    // 结束判定改为「连续多次轮询无变化」计数，而非「绝对静默时长」，
    // 以容忍深度思考等场景下的长自然停顿，避免把未输出完的内容误判为完成。
    stablePollsAfterNet: 6, // 已收到流结束信号后，需连续 6 次轮询(约2.4s)文本无变化才算完成
    stablePollsDomOnly: 25, // 无网络信号时，需连续 25 次轮询(约10s)文本无变化才算完成
    startGraceMs: 3000,     // 任务开始后的最短观察时间，防止过早收尾
    elementTimeoutMs: 15000 // 等待输入框/发送按钮出现的上限
  };

  /** 当前正在执行的任务；为 null 表示空闲 */
  var job = null;
  /** 与 Service Worker 的持久连接 */
  var port = null;
  /** 已累计监听到的网络文本长度，仅用于日志诊断 */
  var netTextLength = 0;
  /** 「探测无果」诊断日志的节流时间戳 */
  var pickNullDiagAt = 0;

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
  /**
   * 判断元素是否为模型的「思考块」（应被忽略，只保留最终回复）。
   *
   * 覆盖常见结构：
   *   - DeepSeek 网页版的 ``<details>`` 折叠区（summary 为 "Thought for N seconds"）
   *   - 任何 class / id / data-* 属性包含 think / thought / reasoning 关键词的元素
   *   - 标准 ``<think>`` 标签
   *
   * @param {Element} el 待判定元素
   * @returns {boolean}
   */
  function isThinkBlock(el) {
    if (!el || el.nodeType !== 1) {
      return false;
    }
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'details' || tag === 'think') {
      return true;
    }
    var sig = (el.className || '') + '|' + (el.id || '');
    var attrs = el.attributes || [];
    for (var i = 0; i < attrs.length; i += 1) {
      sig += '|' + attrs[i].name + '|' + attrs[i].value;
    }
    sig = sig.toLowerCase();
    return /think|thought|reasoning|chain-of-thought|cot/.test(sig);
  }

  /**
   * 判断元素自身或其后裔是否包含「思考块」。
   * @param {Element} el 待判定元素
   * @returns {boolean}
   */
  function containsThinkBlock(el) {
    if (!el || !el.querySelectorAll) {
      return false;
    }
    if (isThinkBlock(el)) {
      return true;
    }
    var nodes = el.querySelectorAll('*');
    for (var i = 0; i < nodes.length; i += 1) {
      if (isThinkBlock(nodes[i])) {
        return true;
      }
    }
    return false;
  }

  /**
   * 读取回复容器的完整文本，把模型「思考过程」用 ``<think>...</think>`` 包裹，
   * 最终答案放在标签之外。
   *
   * 设计要点：
   *   - 思考块（``<details>`` / ``<think>`` / 含 think 关键词的元素）通常可折叠，
   *     ``innerText`` 对折叠内容返回空，因此读思考块用 ``textContent``（不关心渲染，
   *     能拿到折叠态下的完整思考正文）；
   *   - 最终答案区正常可见，用 ``innerText`` 读取即可；
   *   - 按文档顺序拼接：思考块在前、答案在后。
   *
   * @param {Element} el 回复容器
   * @returns {string} 含 ``<think>`` 包裹的完整回复文本
   */
  function readReplyText(el) {
    if (!el) {
      return '';
    }
    // 1) 收集顶层思考块（跳过嵌套在另一思考块内的）。
    //    同时记录「含折叠标题的原始文本」(raw) 与「去除 <summary> 后的干净正文」(clean)：
    //    后续用 raw 从容器全文里精确剔除，答案区只要不在思考块 DOM 内就一定保留。
    var cleanList = [];      // 顶层思考块（用于 <think> 包裹输出，避免同一块重复计入）
    var allThinkTexts = [];  // 全部思考块文本（含嵌套/答案区复述），用于从最终答案中剔除
    var all = el.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      var node = all[i];
      if (!isThinkBlock(node)) {
        continue;
      }
      var parent = node.parentElement;
      var nested = false;
      while (parent && parent !== el) {
        if (isThinkBlock(parent)) {
          nested = true;
          break;
        }
        parent = parent.parentElement;
      }
      // 折叠标题（"Thought for N seconds"）位于 <summary>，不属于思考正文，
      // 移除 <summary> 后读到的才是纯思考正文。
      var blockClone = node.cloneNode(true);
      var summ = blockClone.querySelectorAll('summary');
      for (var s = 0; s < summ.length; s += 1) {
        if (summ[s].parentNode) {
          summ[s].parentNode.removeChild(summ[s]);
        }
      }
      var clean = (blockClone.textContent || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();
      // 兜底剔除折叠标题行（"Thought for N seconds" 等，可能不在 <summary> 标签里）
      clean = clean.replace(/Thought for[^\n]*\n?/gi, '').trim();
      if (!clean) {
        continue;
      }
      // 所有思考块文本都收集，后续从答案区统一剔除（含答案区里嵌套或复述的思考块，
      // 避免模型把思考内容在最终答案里又重复一遍）；去重避免 <think> 输出重复
      if (allThinkTexts.indexOf(clean) === -1) {
        allThinkTexts.push(clean);
        if (!nested) {
          cleanList.push(clean);
        }
      }
    }

    // 2) 主文本：容器全文（textContent，不受折叠/可见性影响）减去「全部思考块」文本。
    //    减去所有思考块（含嵌套/答案区复述）而非仅顶层，可避免最终答案里残留思考内容。
    var full = (el.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .trim();
    var main = full;
    for (var r = 0; r < allThinkTexts.length; r += 1) {
      main = main.split(allThinkTexts[r]).join('');
    }
    main = main
      .replace(/Thought for[^\n]*\n?/gi, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!main) {
      // 兜底：减去思考正文后主文本为空，说明答案可能也被包在思考块内，
      // 回退容器全文，保证最终答案不丢失。
      main = full;
    }

    // 3) 按文档顺序拼接：思考在前，答案在后
    var out = '';
    if (cleanList.length > 0) {
      out += '<think>\n' + cleanList.join('\n\n') + '\n</think>';
    }
    if (main) {
      out += (out ? '\n\n' : '') + main;
    }
    return out.trim();
  }

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
   * 单个快照条目文本的上限（字符数）。
   * 超长文本（如整页历史容器）截断存储，避免快照占用过多内存；
   * 截断只影响前缀剥离的精度，不影响「文本是否变化」的判定。
   */
  var SNAPSHOT_TEXT_LIMIT = 50000;

  /**
   * 对页面做一次文本快照，用于后续计算变化量与基线剥离。
   *
   * 与旧版（仅存长度）不同，这里保存归一化后的文本内容：
   *   - 既能判断「文本增长」，也能判断「文本被替换 / 变短」——
   *     SPA 站点在多轮对话中常复用同一 DOM 节点渲染新回复，
   *     此时长度可能不变甚至变短，只有内容比较才能感知变化；
   *   - 命中容器后可用快照文本作为基线，把旧回复从累积文本中剥离。
   *
   * @returns {Map<Element, string>} 元素到归一化文本的映射
   */
  function snapshotTexts() {
    var snapshot = new Map();
    var candidates = collectCandidates();
    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (!isVisible(el)) {
        continue;
      }
      var text = readText(el);
      if (text.length > SNAPSHOT_TEXT_LIMIT) {
        text = text.slice(0, SNAPSHOT_TEXT_LIMIT);
      }
      snapshot.set(el, text);
    }
    return snapshot;
  }

  /**
   * 依据文本变化自动挑选最可能的响应容器。
   *
   * 策略：
   *   1. 只考虑可见、非输入框、且「文本发生变化」的元素。
   *      变化包括三种形态（旧版只识别第 1 种，是「第二轮起提取不到」的根因）：
   *        a) 文本增长（绝大多数站点的流式追加）；
   *        b) 文本被整体替换且长度变短（SPA 复用同一节点渲染新回复，
   *           新回复比上一轮短时 delta < 0，旧版直接漏掉）；
   *        c) 文本被替换但长度恰好不变（同样复用场景）；
   *   2. 若某元素的某个后代贡献了几乎全部变化，则该元素是「祖先容器」，予以排除，
   *      从而选中粒度最细、最贴近真实回答的那个节点；
   *   3. 在剩余元素中按变化幅度与 DOM 深度排序取最优。
   *
   * @param {Map<Element, string>} snapshot 发送前的文本快照
   * @param {string} prompt 本次发送的 prompt 文本
   * @returns {Element|null} 命中的响应容器，未产生任何变化时返回 null
   */
  function pickResponseElement(snapshot, prompt) {
    var candidates = collectCandidates();
    var changed = [];
    /** 诊断统计：各类被过滤掉的候选数量，用于「识别不到」时定位原因 */
    var stats = { invisible: 0, input: 0, think: 0, promptLike: 0, unchanged: 0 };

    for (var i = 0; i < candidates.length; i += 1) {
      var el = candidates[i];
      if (!isVisible(el)) {
        stats.invisible += 1;
        continue;
      }
      var tag = (el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
        stats.input += 1;
        continue;
      }
      // 不选思考块本身（其变化通常最大，但含的是思考过程而非完整回复）
      if (isThinkBlock(el)) {
        stats.think += 1;
        continue;
      }
      var text = readText(el);
      // 排除页面 chrome 区域的元素：侧边栏（对话名列表）、头部（标题/模式切换）、
      // 导航内的元素变化（新对话命名、模式徽标、免责声明出现）与模型回复无关
      if (el.closest && el.closest('nav,aside,header,[role="navigation"]')) {
        continue;
      }
      // 排除「用户消息气泡」元素：文本以 prompt 开头且只多少量余量（UI 标签）。
      // 使用绝对余量（+30）而非倍数/长度门槛，兼容短 prompt（如「你好」）；
      // 也不能用「包含 prompt 即排除」——模型复述 prompt 原文是常态，会误杀回复容器。
      if (isPromptEcho(text, prompt)) {
        stats.promptLike += 1;
        continue;
      }
      var previous = snapshot.has(el) ? snapshot.get(el) : '';
      // 内容完全一致（含两者皆为空串）视为无变化
      if (text === previous) {
        stats.unchanged += 1;
        continue;
      }
      // 变化幅度取差值的绝对值：替换/变短场景同样有效
      var delta = Math.abs(text.length - previous.length);
      // 长度相同但内容不同（整体替换且长度巧合相等）时，视为有 1 个单位的变化，
      // 保证这类容器不会因 delta 为 0 而被丢弃
      if (delta === 0) {
        delta = 1;
      }
      changed.push({ el: el, delta: delta, length: text.length });
    }

    if (changed.length === 0) {
      // 节流输出诊断（最多每 5 秒一次）：帮助定位「识别不到回复」时各环节过滤情况
      var nowMs = Date.now();
      if (nowMs - pickNullDiagAt > 5000) {
        pickNullDiagAt = nowMs;
        log('探测无果：候选 ' + candidates.length + '，不可见 ' + stats.invisible +
          '，输入类 ' + stats.input + '，思考块 ' + stats.think +
          '，疑似用户消息 ' + stats.promptLike + '，无变化 ' + stats.unchanged, 'debug');
      }
      return null;
    }

    var filtered = [];
    for (var a = 0; a < changed.length; a += 1) {
      var current = changed[a];
      var isAncestor = false;
      for (var b = 0; b < changed.length; b += 1) {
        if (a === b) {
          continue;
        }
        var other = changed[b];
        if (current.el !== other.el && current.el.contains(other.el) && other.delta >= current.delta * 0.95) {
          isAncestor = true;
          break;
        }
      }
      if (!isAncestor) {
        filtered.push(current);
      }
    }

    var list = filtered.length > 0 ? filtered : changed;
    list.sort(function (x, y) {
      if (y.delta !== x.delta) {
        return y.delta - x.delta;
      }
      return x.length - y.length; // 增量相同时取更短（更精确）的容器
    });

    // 计算每个候选元素的深度，用于多轮对话页面的保护
    for (var g = 0; g < list.length; g += 1) {
      var depthNode = list[g].el;
      var depth = 0;
      while (depthNode && depthNode !== document.body) {
        depth += 1;
        depthNode = depthNode.parentElement;
      }
      list[g].depth = depth;
    }

    // 重新排序：优先选择深度大的元素（更靠近具体回复）
    list.sort(function (x, y) {
      if (y.delta !== x.delta) {
        return y.delta - x.delta;
      }
      if (y.depth !== x.depth) {
        return y.depth - x.depth;
      }
      return x.length - y.length;
    });

    // 多轮对话页上，整页消息列表也会随新回复变化，且变化量最大。
    // 这里跳过明显包含过多后代块级元素的整页历史容器，优先取单条回复。
    var best = null;
    /** 含「发送前旧内容」的降级候选：多轮对话时消息列表祖先容器会同时包含
     *  旧用户气泡（prompt+模式徽标）与旧回复，直接返回会导致新回复里
     *  混入上一轮全文；仅在无更优候选时才由其兜底。 */
    var staleBest = null;
    for (var c = 0; c < list.length; c += 1) {
      var candidate = list[c];
      // 阈值较旧版下调（20→4）：容器复用+整体替换场景下，短回复的变化量
      // 可能很小，但只要内容确实变了就应当命中；4 以下视为噪音忽略
      if (candidate.delta < 4) {
        continue;
      }
      var blockCount = candidate.el.querySelectorAll("p,div,li,pre,code").length;
      if (blockCount > 1200) {
        continue;
      }
      // 跳过「包含页面 chrome 后代」的容器（body/main 级整页容器）：
      // 这类容器的文本里混有侧边栏对话名、模式徽标、免责声明等 UI 噪音。
      // 仅当所有候选都含 chrome（无更优选择）时才由末尾 fallback 兜底。
      if (candidate.el.querySelector('nav,aside,header,[role="navigation"]')) {
        continue;
      }
      if (isThinkBlock(candidate.el)) {
        continue;
      }
      // 含旧内容（与发送前快照高度重叠）的容器降级处理：
      // 该类容器多半是「消息列表祖先」，文本 = 旧用户气泡 + 旧回复 + 新回复，
      // 优先选择不含旧内容的更细粒度候选（单条新回复节点）
      if (isStaleContent(readText(candidate.el), snapshot)) {
        if (!staleBest) {
          staleBest = candidate;
        }
        continue;
      }
      if (containsThinkBlock(candidate.el)) {
        return candidate.el;
      }
      if (!best) {
        best = candidate;
      }
    }
    if (best) {
      return best.el;
    }
    if (staleBest) {
      log('所有候选均含发送前旧内容，降级使用变化最大的容器（依赖基线剥离旧文）', 'warn');
      return staleBest.el;
    }
    if (list.length) {
      return list[0].el;
    }
    return null;
  }





  // ------------------------------------------------------------------ 文本清理工具

  /**
   * 已知页面 UI 噪音模式（行级/片段级）。
   * 这些文本由站点 UI 渲染产生，与模型回复内容无关，命中即删。
   * 模式要求高度特异（含固定长句或严格整行匹配），避免误伤正常回复。
   */
  var UI_NOISE_PATTERNS = [
    // DeepSeek 回复底部免责声明（常与模式徽标连写成一个片段）
    /(?:DeepThink|Think|Search|R1|V3)\s*Search\s*AI-generated, for reference only/gi,
    /AI-generated, for reference only/gi,
    // DeepSeek 消息头部的模式徽标（仅整行独立出现时才删，防止误删正文单词）；
    // Instant 为非思考模式徽标，同样只按整行匹配避免误删正文单词
    /^\s*-?\s*(DeepThinkSearch|DeepThink|ThinkSearch|Instant)\s*$/gm,
    // 常见对话操作按钮行
    /^\s*(Copy code|复制代码|重新生成|Regenerate|Good response|Bad response)\s*$/gm
  ];

  /**
   * 判断文本是否为「用户消息回声」：以 prompt 开头且总长只比 prompt 多一点余量。
   * 用户消息气泡的文本 = prompt + 少量 UI 标签（如模式名 "Instant"），
   * 而 AI 正常回复即使以 prompt 开头也会远超此长度。
   * 使用绝对余量（而非倍数）以兼容短 prompt（如「你好」，仅 2 字符）。
   * @param {string} text 待判定文本
   * @param {string} prompt 本次发送的 prompt
   * @returns {boolean}
   */
  function isPromptEcho(text, prompt) {
    return !!prompt && !!text &&
      text.indexOf(prompt) === 0 &&
      text.length < prompt.length + 30;
  }

  /**
   * 判断文本是否为「发送前已存在的旧内容」。
   * 虚拟列表重建节点后，含旧回复全文的容器不在快照中（previous=''），
   * 其全部文本会被误当作新内容。此处将候选文本与发送前快照比对：
   * 高度重叠（互相包含且旧文本足够长）即判定为旧内容。
   *
   * 注意：快照文本来自 innerText，轮询文本来自 textContent，折叠内容与
   * 空白渲染差异会使严格子串匹配失效（旧版 bug 根因之一），
   * 故比较前双方都做空白归一化（squash）。
   * @param {string} text 待判定文本
   * @param {Map<Element, string>} snapshot 发送前的文本快照
   * @returns {boolean}
   */
  function isStaleContent(text, snapshot) {
    if (!text || text.length < 50) {
      return false;
    }
    var squashed = squash(text);
    if (squashed.length < 50) {
      return false;
    }
    var iter = snapshot.values();
    var item = iter.next();
    while (!item.done) {
      var old = item.value;
      // 旧文本需足够长（squash 后 >50 字符）才可信，避免页面零星短语误判
      if (old && old.length > 50) {
        var oldSquashed = squash(old);
        if (oldSquashed.length > 50 &&
          (oldSquashed.indexOf(squashed) !== -1 || squashed.indexOf(oldSquashed) !== -1)) {
          return true;
        }
      }
      item = iter.next();
    }
    return false;
  }

  /**
   * 去除文本中的全部空白字符，用于跨文本源（innerText / textContent）的宽松比较。
   * 两种读取方式在折叠内容、换行、连续空白上存在系统性差异，
   * 严格子串匹配会因此失效；squash 后比较可消除这类噪音差异。
   * @param {string} text 原始文本
   * @returns {string} 仅保留非空白字符的文本
   */
  function squash(text) {
    return String(text || '').replace(/\s+/g, '');
  }

  /**
   * 宽松前缀剥离：判断 oldText 是否为 text 的「前缀」（忽略空白差异）。
   * 通过双指针逐字符消耗实现：oldText 与 text 各自跳过空白后逐字符比对，
   * 全部匹配成功时返回旧内容在 text 中的结束位置（下标），不匹配返回 -1。
   * 用途：容器为虚拟列表重建的新节点（不在快照中）时，精确基线缺失，
   * 用该函数从快照文本中找到「旧回复前缀」并剥掉，只保留本轮新回复。
   * @param {string} text 当前读取的完整文本
   * @param {string} oldText 发送前的旧文本（来自快照）
   * @returns {number} 旧内容在 text 中的结束下标；不是前缀返回 -1
   */
  function stalePrefixEnd(text, oldText) {
    if (!text || !oldText || oldText.length < 50) {
      return -1;
    }
    var ti = 0;
    var oi = 0;
    while (oi < oldText.length) {
      var oc = oldText.charAt(oi);
      if (/\s/.test(oc)) {
        oi += 1;
        continue;
      }
      // text 侧跳过空白，对齐 oldText 的下一个非空白字符
      while (ti < text.length && /\s/.test(text.charAt(ti))) {
        ti += 1;
      }
      if (ti >= text.length || text.charAt(ti) !== oc) {
        return -1;
      }
      ti += 1;
      oi += 1;
    }
    return ti;
  }

  /**
   * 清理回复文本，仅移除确定性的页面噪音。
   *
   * 注意：本扩展是通用 OpenAI API 代理，模型回复中的代码块、JSON、引用块
   * 都属于「回复本体」，绝不能删除（旧版删除 ``` 代码块导致模型输出
   * JSON/代码时服务端收到空串）。此处只清理与页面渲染相关的标记：
   *   - <system>/<user> 标签包裹的内容（部分站点用来渲染消息角色）；
   *   - 已知 UI 噪音片段（免责声明、模式徽标、操作按钮行）；
   *   - 多余空白归一化。
   *
   * @param {string} text 原始文本
   * @returns {string} 清理后的文本
   */
  function cleanReplyText(text) {
    if (!text) {
      return '';
    }
    var out = String(text);
    // 移除 system 标签包裹的内容
    out = out.replace(/<system>\n?[\s\S]*?<\/system>/gi, '');
    // 移除 user 标签包裹的内容
    out = out.replace(/<user>\n?[\s\S]*?<\/user>/gi, '');
    // 移除已知 UI 噪音片段
    for (var i = 0; i < UI_NOISE_PATTERNS.length; i += 1) {
      out = out.replace(UI_NOISE_PATTERNS[i], '');
    }
    // 清理多余空白
    out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return out;
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

    // 清理回复文本，移除系统标记和噪音
    var text = cleanReplyText(current.lastText);
    // 兜底防线：锁定内容非空但清洗后为空，说明全是 UI 噪音碎片，
    // 不能把空串当成功回复返回（表现为「AI 未回复返回空」），改为报错。
    if (!text && current.lastText && current.lastText.trim()) {
      report({
        action: 'error',
        requestId: current.requestId,
        code: 'empty_reply',
        message: '锁定的回复内容清洗后为空（均为页面 UI 噪音），未提取到有效回复'
      });
      return;
    }
    var payload = {
      action: 'done',
      requestId: current.requestId,
      text: text,
      finishReason: finishReason
    };

    // 诊断：输出回复容器的标签/class 与命中的思考块，便于定位「答案丢失」类问题
    try {
      var dbgEl = current.element;
      var dbg = 'root=' + (dbgEl ? dbgEl.tagName + '.' + (dbgEl.className || '').toString().slice(0, 50) : 'null');
      if (dbgEl) {
        var tb = [];
        var da = dbgEl.querySelectorAll('*');
        for (var di = 0; di < da.length && tb.length < 6; di += 1) {
          if (isThinkBlock(da[di])) {
            tb.push(da[di].tagName + '.' + (da[di].className || '').toString().slice(0, 30));
          }
        }
        dbg += ' | thinkBlocks=[' + (tb.join('; ') || 'none') + ']';
      }
      dbg += ' | replyLen=' + text.length;
      report({ action: 'log', level: 'debug', message: '[content][diag] ' + dbg });
    } catch (e) {
      // 诊断失败不影响主流程
    }

    report(payload);
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
    // 复用本轮任务已选定的 element（深度思考块折叠时 innerText 检测不到变化，
    // 每轮重选会抖动；选定一次后持续复用，直到容器失效）。
    if (!element && job.element && document.body.contains(job.element) && isVisible(job.element)) {
      element = job.element;
    }
    if (!element) {
      element = pickResponseElement(job.snapshot, job.prompt);
      job.element = element;
    }
    // 基线随容器走：虚拟列表可能重建节点导致 element 更换，旧基线对新容器完全错位，
    // 必须在容器变化时重新记录（而非只在任务开始记录一次）。
    if (element && job.baselineEl !== element) {
      job.baselineEl = element;
      job.baselineText = job.snapshot.has(element) ? job.snapshot.get(element) : '';
      // 容器切换后旧前缀不再适用，宽松基线需重新探测
      job.looseBaseline = null;
      if (job.baselineText) {
        log('容器切换，重新记录基线文本 ' + job.baselineText.length + ' 字符', 'debug');
      }
    }

    var text = readReplyText(element);
    // 基线剥离：readReplyText 的输出若以基线（旧回复）为前缀，则切掉前缀只保留新内容；
    // 前缀不匹配（容器被整体替换、或归一化导致错位）时保留全量，宁可多带旧文也不丢新回复。
    if (text && job.baselineText && text.indexOf(job.baselineText) === 0) {
      var stripped = text.slice(job.baselineText.length).trim();
      // 防御：剥离后为空说明基线恰好等于当前全文（虚拟列表整段重渲染等场景），
      // 此时基线已失效，回退使用原文，避免把新回复整段剥掉导致提取为空
      if (stripped) {
        text = stripped;
      } else {
        job.baselineText = ''; // 基线失效，后续轮次不再剥离
        log('基线剥离后为空，判定基线失效，回退全文', 'warn');
      }
    } else if (text && text.length >= 50) {
      // 宽松基线剥离兜底：精确前缀匹配失败时（基线为空，或快照文本来自
      // innerText 而当前文本来自 textContent，空白/折叠差异导致前缀错位），
      // 用「忽略空白差异」的双指针匹配从快照文本中找出旧内容前缀并剥掉。
      // 典型场景：虚拟列表重建节点，含旧回复的消息列表容器不在快照中，
      // 旧版此时会把「旧用户气泡(你好+Instant徽标)+旧回复+新回复」整段返回。
      var looseBaseline = job.looseBaseline;
      if (looseBaseline !== '') {
        // 首次进入时尚未确定宽松基线：遍历快照找「是当前文本前缀」的最长旧文本
        if (!looseBaseline) {
          var bestEnd = -1;
          var bestOld = null;
          var iter = job.snapshot.values();
          var item = iter.next();
          while (!item.done) {
            var oldText = item.value;
            if (oldText && oldText.length > 50) {
              var end = stalePrefixEnd(text, oldText);
              if (end > bestEnd) {
                bestEnd = end;
                bestOld = oldText;
              }
            }
            item = iter.next();
          }
          looseBaseline = bestOld || '';
          job.looseBaseline = looseBaseline;
          if (bestEnd > 0) {
            log('精确基线未命中，宽松匹配到旧内容前缀 ' + bestEnd + ' 字符，剥离', 'debug');
          }
        }
        if (looseBaseline) {
          var looseEnd = stalePrefixEnd(text, looseBaseline);
          // 剥离后必须仍有剩余内容，否则视为基线失效（如新回复恰好复述旧文）
          if (looseEnd > 0 && looseEnd < text.length) {
            text = text.slice(looseEnd).trim();
          } else if (looseEnd >= text.length) {
            job.looseBaseline = '';
            log('宽松基线覆盖全文，判定基线失效，回退全文', 'warn');
          }
        }
      }
    }
    // 无效内容拦截（必须在 prompt 剥离之前，用原始 text 判断）：
    // AI 回复开始前页面上有两类「假信号」会被误当回复容器锁定：
    //   1) 用户消息回声：容器文本 = prompt + 少量 UI 标签（如「你好Instant」），
    //      若先剥 prompt 再判回声，indexOf(prompt)===0 永远为假，校验形同虚设；
    //   2) 纯 UI 噪音：回复区先渲染模式徽标（DeepThinkSearch 等）/免责声明，
    //      正文未到，cleanReplyText 清洗后为空。旧逻辑把这类静止碎片记为
    //      hasContent=true，稳定后提前 finish 且清洗后返回空串，
    //      表现为「AI 未回复 crx 就返回空」。
    // 处理：清空锁定容器强制重探、不计稳定、不计 hasContent；
    // 且不 return——保证下方超时判定仍可触发，AI 始终不回复时按 no_response 报错。
    if (text && (isPromptEcho(text, job.prompt) || !cleanReplyText(text))) {
      // 节流日志：同一碎片文本只记一次，避免每轮轮询刷屏
      if (job.noiseLoggedText !== text) {
        job.noiseLoggedText = text;
        log('命中的是用户消息回声或纯 UI 噪音，丢弃并重探容器', 'warn');
      }
      if (job.element) {
        job.element = null;
        job.baselineEl = null;
        job.baselineText = null;
        job.looseBaseline = null;
      }
      job.stablePolls = 0;
      text = '';
    }
    // prompt 前缀剥离：若最终选中的是「累积型祖先容器」（文本=旧对话+prompt+新回复），
    // 基线剥掉旧对话后开头残留的是本次 prompt，需一并剥掉才是纯回复。
    if (text && job.prompt && text.indexOf(job.prompt) === 0) {
      text = text.slice(job.prompt.length).trim();
    }
    if (text && text !== job.lastText) {
      // DOM 是累积文本，通常只需取新增部分；若发生重排则整段替换
      var delta = text.indexOf(job.lastText) === 0 ? text.slice(job.lastText.length) : text;
      job.lastText = text;
      job.lastChangeAt = now;
      job.hasContent = true;
      job.stablePolls = 0; // 内容有变化，重置连续稳定计数
      // 注意：无论外部请求是否流式，CRX 都只攒完整结果，不在过程中上报增量区块。
      // 增量仅在 done 时随完整文本一次性回传，避免把未完成的碎片透传给请求端。
      if (delta) {
        report({ action: 'log', level: 'debug', message: '[content] 累积增量 ' + delta.length + ' 字符（暂不回传）' });
      }
    } else if (text && text === job.lastText) {
      // 本轮文本与上一轮一致，连续稳定计数 +1
      job.stablePolls += 1;
    } else {
      // text 为空：可能是「尚无可读内容」，也可能是虚拟列表重渲染导致容器暂时失联。
      // 后者发生时任务往往已有内容（hasContent=true），若清零稳定计数会导致
      // 回复完成后永远无法满足结束条件（表现为「回复完扩展不返回」）。
      // 因此这里统一按稳定处理：无内容时 hasContent=false 不会触发结束，无副作用；
      // 有内容时容器短暂失联不再阻断结束判定。
      job.stablePolls += 1;
    }

    // 结束判定：基于「连续多次轮询文本无变化」，而非绝对静默时长。
    //   - 流式站点（已收到 net_done）：流真结束后只需较短连续稳定窗口，给 DOM 渲染留缓冲；
    //   - 无网络信号站点：需很长连续稳定窗口，容忍深度思考的自然长停顿，避免提前截断。
    var requiredPolls = job.netDone ? CFG.stablePollsAfterNet : CFG.stablePollsDomOnly;
    if (job.hasContent && job.stablePolls >= requiredPolls && elapsed >= CFG.startGraceMs) {
      // 旧内容校验：虚拟列表重建节点后，含旧回复全文的新节点不在快照中，
      // 其文本会被整体误当作新内容（表现为「第二次返回第一次的回复」）。
      // 结束前与发送前快照比对，高度重叠则判定为旧内容：重探容器再给一次机会，
      // 重试次数用尽后接受（避免陷入死等）。
      if (isStaleContent(job.lastText, job.snapshot) && job.staleRetries < 2) {
        job.staleRetries += 1;
        log('稳定内容与发送前页面高度重叠，疑似旧回复，重探容器（第 ' + job.staleRetries + ' 次）', 'warn');
        job.element = null;
        job.baselineEl = null;
        job.baselineText = null;
        job.looseBaseline = null;
        job.lastText = '';
        job.hasContent = false;
        job.stablePolls = 0;
        return;
      }
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

    // 快照必须在「点击发送之前」拍摄：
    //   - 旧版在发送后延迟 300ms 拍快照，第二轮起页面已热、新回复渲染极快，
    //     部分甚至全部新回复会被误入快照，导致后续轮询判定「无变化」而提取失败；
    //   - 提前拍摄后，用户消息气泡会成为「变化最大」的元素，
    //     由 pickResponseElement 的 prompt 排除规则过滤（见该函数注释）。
    var snapshot = snapshotTexts();
    var promptText = String(payload.prompt || '');

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

    job = {
      requestId: requestId,
      profile: profile,
      prompt: promptText,
      startedAt: Date.now(),
      lastChangeAt: Date.now(),
      timeoutMs: payload.timeoutMs || 180000,
      snapshot: snapshot,
      baselineEl: null,
      baselineText: null,
      lastText: '',
      hasContent: false,
      netDone: false,
      stablePolls: 0,
      element: null,
      signalReported: false,
      staleRetries: 0,
      noiseLoggedText: '',
      looseBaseline: null,
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
