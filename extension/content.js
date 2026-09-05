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
      // 排除「用户消息气泡」元素：其文本以 prompt 开头且总长与 prompt 相当。
      // 注意不能用「包含 prompt 即排除」——模型在回复中引用/复述 prompt 原文
      // （代码改写、JSON 处理等场景）是常态，包含式误杀会导致回复容器永远选不中。
      // 祖先容器（旧对话+prompt+新回复）不以 prompt 开头，不受此规则影响，
      // 其混入的 prompt 由 tick 中的前缀剥离兜底。
      if (
        prompt && prompt.length > 20 && text &&
        text.indexOf(prompt) === 0 && text.length < prompt.length * 1.5
      ) {
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
      if (!isThinkBlock(candidate.el) && containsThinkBlock(candidate.el)) {
        return candidate.el;
      }
      if (!best && !isThinkBlock(candidate.el)) {
        best = candidate;
      }
    }
    if (best) {
      return best.el;
    }
    if (list.length) {
      return list[0].el;
    }
    return null;
  }





  // ------------------------------------------------------------------ 文本清理工具

  /**
   * 清理回复文本，仅移除确定性的页面噪音。
   *
   * 注意：本扩展是通用 OpenAI API 代理，模型回复中的代码块、JSON、引用块
   * 都属于「回复本体」，绝不能删除（旧版删除 ``` 代码块导致模型输出
   * JSON/代码时服务端收到空串）。此处只清理与页面渲染相关的标记：
   *   - <system>/<user> 标签包裹的内容（部分站点用来渲染消息角色）；
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
    }
    // prompt 前缀剥离：若最终选中的是「累积型祖先容器」（文本=旧对话+prompt+新回复），
    // 基线剥掉旧对话后开头残留的是本次 prompt，需一并剥掉才是纯回复。
    if (text && job.prompt && job.prompt.length > 20 && text.indexOf(job.prompt) === 0) {
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
