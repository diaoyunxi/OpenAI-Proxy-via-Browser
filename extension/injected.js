/**
 * injected.js —— 运行在主世界（MAIN world）的网络嗅探脚本。
 *
 * 职责：
 *   1. 劫持 window.fetch / XMLHttpRequest，把目标请求的响应流“分叉”一份出来；
 *   2. 解析 SSE 文本行，把「有数据流动」「流已结束」两类信号回传给 content script；
 *   3. 尽力从 SSE 的 JSON 中提取增量文本（仅作辅助，文本真相源仍是 DOM）。
 *
 * 与 content script 的通信只能通过 window.postMessage（两个世界彼此隔离）。
 * 只有在收到 arm 指令期间才启用拦截，避免对页面日常访问造成任何性能影响。
 */
(function () {
  'use strict';

  if (window.__oapInjected__) {
    return;
  }
  window.__oapInjected__ = true;

  /** 消息通道标记，content script 依据该字段过滤消息 */
  var CHANNEL = 'OAP_NET_CHANNEL';

  /** 默认命中规则：URL 中出现这些关键词即视为对话响应请求 */
  var DEFAULT_PATTERN = /(completion|conversation|chat|message|query|stream|generate)/i;

  /** 尝试从 SSE 的 JSON 里取文本的候选字段名（按优先级排列） */
  var TEXT_KEYS = ['content', 'text', 'answer', 'delta', 'chunk', 'result', 'output', 'response'];

  var state = {
    armed: false,
    urlPattern: '',
    urlRegex: null,
    seq: 0
  };

  /**
   * 向 content script 发送消息。
   * @param {Object} payload 消息内容
   */
  function post(payload) {
    var message = Object.assign({ __oap: CHANNEL }, payload);
    try {
      window.postMessage(message, '*');
    } catch (err) {
      // 结构化克隆失败时不影响页面功能，静默忽略
    }
  }

  /**
   * 判断某个 URL 是否为需要监听的目标请求。
   * @param {string} url 请求地址
   * @returns {boolean} 命中返回 true
   */
  function isTargetUrl(url) {
    if (!url) {
      return false;
    }
    if (state.urlRegex) {
      return state.urlRegex.test(url);
    }
    if (state.urlPattern) {
      return url.indexOf(state.urlPattern) !== -1;
    }
    return DEFAULT_PATTERN.test(url);
  }

  /**
   * 设置拦截开关与匹配规则。
   * @param {string} urlPattern 用户自定义匹配规则，支持普通子串或 /正则/ 写法
   */
  function applyPattern(urlPattern) {
    state.urlPattern = typeof urlPattern === 'string' ? urlPattern.trim() : '';
    state.urlRegex = null;
    if (!state.urlPattern) {
      return;
    }
    var matched = state.urlPattern.match(/^\/(.*)\/([gimsuy]*)$/);
    if (matched) {
      try {
        state.urlRegex = new RegExp(matched[1], matched[2].replace('g', ''));
      } catch (err) {
        state.urlRegex = null; // 正则非法时退化为子串匹配
      }
    }
  }

  /**
   * 从 SSE 的 data 行中尽力提取增量文本。
   * @param {string} payload data 行内容（去掉 "data:" 前缀后）
   * @returns {string} 提取到的文本，失败返回空串
   */
  function extractText(payload) {
    if (!payload || payload === '[DONE]') {
      return '';
    }
    var data;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      return '';
    }
    return deepFindText(data, 0);
  }

  /**
   * 深度优先查找对象中的文本内容。
   * @param {*} node 当前节点
   * @param {number} depth 当前递归深度
   * @returns {string} 找到的文本，未找到返回空串
   */
  function deepFindText(node, depth) {
    if (depth > 6 || node === null || node === undefined) {
      return '';
    }
    if (typeof node === 'string') {
      return node;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) {
        var found = deepFindText(node[i], depth + 1);
        if (found) {
          return found;
        }
      }
      return '';
    }
    if (typeof node !== 'object') {
      return '';
    }

    // OpenAI 官方结构优先
    if (Array.isArray(node.choices) && node.choices.length > 0) {
      var choice = node.choices[0];
      if (choice.delta && typeof choice.delta.content === 'string') {
        return choice.delta.content;
      }
      if (choice.message && typeof choice.message.content === 'string') {
        return choice.message.content;
      }
    }
    for (var k = 0; k < TEXT_KEYS.length; k += 1) {
      var value = node[TEXT_KEYS[k]];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
    var keys = Object.keys(node);
    for (var j = 0; j < keys.length; j += 1) {
      var nested = node[keys[j]];
      if (nested && typeof nested === 'object') {
        var result = deepFindText(nested, depth + 1);
        if (result) {
          return result;
        }
      }
    }
    return '';
  }

  /**
   * 逐行处理 SSE 文本，识别事件边界并上报信号。
   * @param {string} line 单行文本
   * @param {string} url 请求地址
   */
  function handleLine(line, url) {
    if (!line) {
      return;
    }
    if (line.indexOf('data:') !== 0) {
      return;
    }
    var payload = line.slice(5).trim();
    if (!payload) {
      return;
    }
    // 只要收到任意数据行，就说明响应已经开始流动
    post({ type: 'net_signal', url: url });

    if (payload === '[DONE]') {
      post({ type: 'net_done', url: url });
      return;
    }
    var text = extractText(payload);
    if (text) {
      post({ type: 'net_text', url: url, text: text });
    }
  }

  /**
   * 读取一条响应流，边解码边解析 SSE。
   * @param {ReadableStream} stream 分叉出来的响应流
   * @param {string} url 请求地址
   */
  function pumpStream(stream, url) {
    var reader;
    try {
      reader = stream.getReader();
    } catch (err) {
      post({ type: 'net_error', url: url, message: String((err && err.message) || err) });
      return;
    }
    var decoder = new TextDecoder('utf-8');
    var buffer = '';

    function flushRemainder() {
      var rest = buffer.trim();
      buffer = '';
      if (rest) {
        handleLine(rest, url);
      }
    }

    function loop() {
      reader
        .read()
        .then(function (result) {
          if (result.done) {
            flushRemainder();
            post({ type: 'net_done', url: url });
            return;
          }
          buffer += decoder.decode(result.value, { stream: true });
          var index = buffer.indexOf('\n');
          while (index !== -1) {
            var line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            handleLine(line, url);
            index = buffer.indexOf('\n');
          }
          loop();
        })
        .catch(function (err) {
          flushRemainder();
          post({ type: 'net_error', url: url, message: String((err && err.message) || err) });
        });
    }

    loop();
  }

  // ---------------------------------------------------------------- fetch 拦截

  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var url = '';
      if (typeof input === 'string') {
        url = input;
      } else if (input && typeof input.url === 'string') {
        url = input.url;
      }

      var promise = nativeFetch.call(this, input, init);
      if (!state.armed || !isTargetUrl(url)) {
        return promise;
      }

      return promise.then(function (response) {
        try {
          if (!response || !response.ok || !response.body || typeof response.body.tee !== 'function') {
            return response;
          }
          var branches = response.body.tee();
          pumpStream(branches[1], url);
          // 用另一条分支重建响应，保证页面自身逻辑完全不受影响
          return new Response(branches[0], {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          });
        } catch (err) {
          return response; // 拦截失败必须无损回退
        }
      });
    };
  }

  // -------------------------------------------------------------- XHR 拦截

  var NativeXHR = window.XMLHttpRequest;
  if (typeof NativeXHR === 'function') {
    function PatchedXHR() {
      var xhr = new NativeXHR();
      var self = this;
      var method = 'GET';
      var url = '';
      var lastLength = 0;
      var tracked = false;

      var nativeOpen = xhr.open.bind(xhr);
      var nativeSend = xhr.send.bind(xhr);

      Object.defineProperty(this, 'readyState', {
        get: function () {
          return xhr.readyState;
        }
      });
      Object.defineProperty(this, 'status', {
        get: function () {
          return xhr.status;
        }
      });
      Object.defineProperty(this, 'statusText', {
        get: function () {
          return xhr.statusText;
        }
      });
      Object.defineProperty(this, 'responseType', {
        get: function () {
          return xhr.responseType;
        },
        set: function (value) {
          xhr.responseType = value;
        }
      });
      Object.defineProperty(this, 'withCredentials', {
        get: function () {
          return xhr.withCredentials;
        },
        set: function (value) {
          xhr.withCredentials = value;
        }
      });
      Object.defineProperty(this, 'timeout', {
        get: function () {
          return xhr.timeout;
        },
        set: function (value) {
          xhr.timeout = value;
        }
      });
      Object.defineProperty(this, 'responseText', {
        get: function () {
          return xhr.responseText;
        }
      });
      Object.defineProperty(this, 'response', {
        get: function () {
          return xhr.response;
        }
      });

      this.open = function (verb, target) {
        method = String(verb || 'GET').toUpperCase();
        url = String(target || '');
        return nativeOpen.apply(xhr, arguments);
      };
      this.send = function () {
        tracked = state.armed && isTargetUrl(url);
        if (tracked) {
          xhr.addEventListener('readystatechange', function () {
            try {
              var text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
              if (text.length > lastLength) {
                var delta = text.slice(lastLength);
                lastLength = text.length;
                post({ type: 'net_signal', url: url });
                post({ type: 'net_text', url: url, text: delta });
              }
            } catch (err) {
              // 跨域或响应不可读时忽略
            }
          });
          xhr.addEventListener('load', function () {
            post({ type: 'net_done', url: url });
          });
          xhr.addEventListener('error', function () {
            post({ type: 'net_error', url: url, message: 'xhr error' });
          });
        }
        return nativeSend.apply(xhr, arguments);
      };
      this.setRequestHeader = function () {
        return xhr.setRequestHeader.apply(xhr, arguments);
      };
      this.addEventListener = function () {
        return xhr.addEventListener.apply(xhr, arguments);
      };
      this.removeEventListener = function () {
        return xhr.removeEventListener.apply(xhr, arguments);
      };
      this.getResponseHeader = function () {
        return xhr.getResponseHeader.apply(xhr, arguments);
      };
      this.getAllResponseHeaders = function () {
        return xhr.getAllResponseHeaders.apply(xhr, arguments);
      };
      this.abort = function () {
        return xhr.abort.apply(xhr, arguments);
      };
      this.overrideMimeType = function () {
        return xhr.overrideMimeType.apply(xhr, arguments);
      };
      return self;
    }
    window.XMLHttpRequest = PatchedXHR;
  }

  // --------------------------------------------------------- 控制指令接收

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.__oap !== CHANNEL) {
      return;
    }
    var data = event.data;
    if (data.type === 'arm') {
      applyPattern(data.urlPattern);
      state.armed = true;
    } else if (data.type === 'disarm') {
      state.armed = false;
    }
  });
})();
