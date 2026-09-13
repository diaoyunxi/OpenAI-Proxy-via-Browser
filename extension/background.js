/**
 * background.js —— Manifest V3 Service Worker。
 *
 * 职责：
 *   1. 与本地网关维持 WebSocket 长连接（心跳 + 指数退避重连 + alarms 兜底唤醒）；
 *   2. 接收网关下发的 execute 指令，定位目标标签页并派发给 content script；
 *   3. 汇聚 content script 的增量与结果，回传给网关；
 *   4. 当页面网络嗅探失效时，降级启用 chrome.debugger 抓包判定响应结束。
 *
 * 注意：Service Worker 空闲约 30 秒会被回收，因此：
 *   - 所有事件监听器必须在顶层同步注册；
 *   - 不得依赖全局变量保存关键状态（此处仅保存运行期缓存，丢失后可重建）；
 *   - 重连入口必须挂在 chrome.* 事件上，不能依赖 setTimeout 自循环。
 */
'use strict';

/** 默认网关 WebSocket 地址 */
var DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8080/ws';
/** 心跳间隔（毫秒），需小于 Service Worker 的 30 秒空闲阈值 */
var HEARTBEAT_MS = 20000;
/** 发起任务后等待首个网络信号的时间，超时则降级为 debugger 抓包 */
var NETWORK_GRACE_MS = 10000;
/** 下发 run 后等待 content script 回 accepted 的上限：超时说明指令没送达，需重试 */
var ACCEPT_TIMEOUT_MS = 15000;
/** 会话重置导航后，等待新文档 content script 就绪（hello 上报）的上限 */
var NAV_SETTLE_TIMEOUT_MS = 20000;
/** 任务硬超时相对网关超时的宽限：兜底清理悬挂任务，避免扩展被 browser_busy 卡死 */
var TASK_HARD_TIMEOUT_GRACE_MS = 10000;
/** 保活闹钟名称 */
var KEEPALIVE_ALARM = 'oap-keepalive';
/** debugger 使用的 CDP 协议版本 */
var DEBUGGER_VERSION = '1.3';

/** 运行期状态（进程内缓存，Service Worker 重启后会重建） */
var state = {
  socket: null,
  connected: false,
  gatewayUrl: DEFAULT_GATEWAY_URL,
  attempt: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  lastIncomingAt: 0,
  sessionId: null,
  clientId: '',
  currentTask: null,
  debugSession: null,
  /** 下一次任务开始前需要「开启新对话」的标签页 id；null 表示无需重置 */
  pendingNewChat: null,
  /** 最近一次收到 content script hello 的时间与来源，用于判断新文档是否已就绪 */
  lastHello: null
};

/** tabId -> Port 的映射：与 content script 的持久连接 */
var contentPorts = new Map();
/** 当前打开的弹窗连接（用于状态推送与心跳保活） */
var popupPorts = new Set();

// ------------------------------------------------------------------ 工具函数

/**
 * 生成随机标识。
 * @returns {string} 随机字符串
 */
function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * 读取本地配置。
 * @returns {Promise<Object>} 配置对象，包含 gatewayUrl、clientId、profiles
 */
function loadSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ gatewayUrl: DEFAULT_GATEWAY_URL, clientId: '', profiles: {} }, function (items) {
      var clientId = items.clientId;
      if (!clientId) {
        clientId = 'ext-' + randomId();
        chrome.storage.local.set({ clientId: clientId });
      }
      state.gatewayUrl = items.gatewayUrl || DEFAULT_GATEWAY_URL;
      state.clientId = clientId;
      resolve(items);
    });
  });
}

/**
 * 读取指定站点的配置。
 * @param {string} host 站点域名
 * @returns {Promise<Object>} 站点配置，未配置时返回空对象
 */
function getProfile(host) {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ profiles: {} }, function (items) {
      resolve((items.profiles && items.profiles[host]) || {});
    });
  });
}

/**
 * 保存指定站点的配置。
 * @param {string} host 站点域名
 * @param {Object} profile 配置内容
 * @returns {Promise<boolean>} 保存成功返回 true
 */
function saveProfile(host, profile) {
  return new Promise(function (resolve) {
    chrome.storage.local.get({ profiles: {} }, function (items) {
      var profiles = items.profiles || {};
      profiles[host] = profile;
      chrome.storage.local.set({ profiles: profiles }, function () {
        resolve(!chrome.runtime.lastError);
      });
    });
  });
}

/**
 * 判断 URL 是否命中对话响应请求。
 * @param {string} url 请求地址
 * @param {string} pattern 用户自定义匹配规则（正则或子串）
 * @returns {boolean} 命中返回 true
 */
function matchesUrl(url, pattern) {
  if (!url) {
    return false;
  }
  if (pattern) {
    try {
      return new RegExp(pattern, 'i').test(url);
    } catch (err) {
      return url.indexOf(pattern) !== -1;
    }
  }
  return /(completion|conversation|chat|message|query|stream|generate)/i.test(url);
}

/**
 * 从 URL 中提取主机名。
 * @param {string} url 页面地址
 * @returns {string} 主机名，解析失败返回空串
 */
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
}

// ------------------------------------------------------------------ WebSocket

/**
 * 建立（或在已断开时重建）到网关的 WebSocket 连接。
 */
function ensureConnected() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  connect();
}

/**
 * 建立 WebSocket 连接并绑定事件。
 */
function connect() {
  var socket;
  try {
    socket = new WebSocket(state.gatewayUrl);
  } catch (err) {
    console.warn('[oap] 创建 WebSocket 失败：', err);
    scheduleReconnect();
    return;
  }
  state.socket = socket;

  socket.addEventListener('open', function () {
    state.connected = true;
    state.attempt = 0;
    state.lastIncomingAt = Date.now();
    // 带上当前活动标签页信息，便于网关按 host 精确选中目标标签页，
    // 避免前台页面（如哔哩哔哩）被误当成任务目标。
    var helloTab = null;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs && tabs.length > 0 && tabs[0].url) {
          helloTab = { url: tabs[0].url, title: tabs[0].title || '' };
        }
        send({ v: 1, type: 'hello', client_id: state.clientId, tab: helloTab });
      });
    } catch (err) {
      send({ v: 1, type: 'hello', client_id: state.clientId, tab: null });
    }
    startHeartbeat();
    broadcastStatus();
    console.info('[oap] 已连接到网关：' + state.gatewayUrl);
  });

  socket.addEventListener('message', function (event) {
    state.lastIncomingAt = Date.now();
    handleServerMessage(event.data);
  });

  socket.addEventListener('close', function () {
    state.connected = false;
    state.sessionId = null;
    stopHeartbeat();
    failCurrentTask('browser_not_connected', '网关连接已断开');
    broadcastStatus();
    scheduleReconnect();
  });

  socket.addEventListener('error', function () {
    // close 事件会紧随其后，此处不做额外处理，避免重复重连
  });
}

/**
 * 安排一次指数退避重连（带随机抖动，避免多实例同时冲击网关）。
 */
function scheduleReconnect() {
  if (state.reconnectTimer) {
    return;
  }
  var delay = Math.min(30000, 800 * Math.pow(2, state.attempt));
  delay = delay * (0.5 + Math.random() * 0.5);
  state.attempt = Math.min(state.attempt + 1, 10);
  state.reconnectTimer = setTimeout(function () {
    state.reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * 启动心跳定时器（仅在 Service Worker 存活期间有效）。
 */
function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(function () {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      ensureConnected();
      return;
    }
    send({ v: 1, type: 'heartbeat', ts: Date.now() });
  }, HEARTBEAT_MS);
}

/**
 * 停止心跳定时器。
 */
function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

/**
 * 向网关发送一条消息。
 * @param {Object} payload 消息对象
 * @returns {boolean} 发送成功返回 true
 */
function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    state.socket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    return false;
  }
}

// ------------------------------------------------------------------ 服务端消息

/**
 * 处理网关下发的消息。
 * @param {string} raw 原始文本帧
 */
function handleServerMessage(raw) {
  var message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    console.warn('[oap] 收到非法 JSON 消息');
    return;
  }
  if (!message || typeof message !== 'object') {
    return;
  }

  switch (message.type) {
    case 'welcome':
      state.sessionId = message.session_id || null;
      broadcastStatus();
      break;
    case 'ping':
      send({ v: 1, type: 'heartbeat', ts: Date.now() });
      break;
    case 'execute':
      handleExecute(message);
      break;
    case 'cancel':
      handleCancel(message.request_id);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------ 任务执行

/**
 * 已知 AI 对话站点域名（host 或 host 后缀）。host 为空时优先在其中选择，
 * 避免把前台无关页面（如视频站）误当成任务目标。
 * @type {Array<string>}
 */
var AI_SITE_HOSTS = [
  'chat.deepseek.com',
  'deepseek.com',
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'kimi.moonshot.cn',
  'kimi.com',
  'tongyi.aliyun.com',
  'qwen.ai',
  'yuanbao.tencent.com',
  'doubao.com',
  'gemini.google.com',
  'aistudio.google.com',
  'grok.com',
  'poe.com',
  'perplexity.ai'
];

/**
 * 判断某个 host 是否命中已知 AI 站点（支持精确匹配或后缀匹配）。
 * @param {string} host 待判定域名
 * @returns {boolean}
 */
function isAiSite(host) {
  if (!host) {
    return false;
  }
  for (var i = 0; i < AI_SITE_HOSTS.length; i += 1) {
    if (host === AI_SITE_HOSTS[i] || host.endsWith('.' + AI_SITE_HOSTS[i])) {
      return true;
    }
  }
  return false;
}

/**
 * 查找承载目标站点的标签页。
 * @param {string} host 目标域名；为空时优先返回已知 AI 对话站点标签页，
 *                       都没有再退回当前活动标签页
 * @returns {Promise<chrome.tabs.Tab|null>} 命中的标签页
 */
function findTargetTab(host) {
  return new Promise(function (resolve) {
    chrome.tabs.query({}, function (tabs) {
      if (!tabs || tabs.length === 0) {
        resolve(null);
        return;
      }
      if (host) {
        for (var i = 0; i < tabs.length; i += 1) {
          if (hostOf(tabs[i].url || '') === host) {
            resolve(tabs[i]);
            return;
          }
        }
        resolve(null);
        return;
      }
      // host 为空：优先选已知 AI 站点，避免前台无关页面被误用
      for (var j = 0; j < tabs.length; j += 1) {
        if (isAiSite(hostOf(tabs[j].url || ''))) {
          resolve(tabs[j]);
          return;
        }
      }
      for (var k = 0; k < tabs.length; k += 1) {
        if (tabs[k].active) {
          resolve(tabs[k]);
          return;
        }
      }
      resolve(tabs[0]);
    });
  });
}

/**
 * 确保网络嗅探脚本已注入目标页面（MAIN world，不受页面 CSP 限制）。
 * @param {number} tabId 标签页 id
 * @returns {Promise<boolean>} 注入成功返回 true
 */
function ensureInjected(tabId) {
  return new Promise(function (resolve) {
    chrome.scripting
      .executeScript({ target: { tabId: tabId }, world: 'MAIN', files: ['injected.js'] })
      .then(function () {
        resolve(true);
      })
      .catch(function (err) {
        console.warn('[oap] 注入嗅探脚本失败：', err);
        resolve(false);
      });
  });
}

/**
 * 探测 content script 是否已在目标页面运行。
 *
 * 必须探测而不能盲目注入：manifest 已声明自动注入，重复注入会让 IIFE 再执行一遍，
 * 导致双份 Port、双份轮询，同一次请求被上报两次。
 *
 * @param {number} tabId 标签页 id
 * @returns {Promise<boolean>} 已注入并响应返回 true
 */
function probeContentScript(tabId) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 800);
    try {
      chrome.tabs.sendMessage(tabId, { action: 'ping' }, function (response) {
        if (chrome.runtime.lastError) {
          response = null;
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(!!response);
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    }
  });
}

/**
 * 确保 content script 已在目标页面运行，必要时才注入。
 * @param {number} tabId 标签页 id
 * @returns {Promise<boolean>} 可用返回 true
 */
function ensureContentScript(tabId) {
  if (contentPorts.has(tabId)) {
    return Promise.resolve(true);
  }
  return probeContentScript(tabId).then(function (alive) {
    if (alive) {
      return true;
    }
    return new Promise(function (resolve) {
      chrome.scripting
        .executeScript({ target: { tabId: tabId }, files: ['content.js'] })
        .then(function () {
          resolve(true);
        })
        .catch(function (err) {
          console.warn('[oap] 注入 content script 失败：', err);
          resolve(false);
        });
    });
  });
}

/** 等待标签页加载完成的上限：上一轮结束后页面会整页跳转到新对话页，需等它加载完再注入 */
var TAB_READY_TIMEOUT_MS = 10000;
/** 轮询标签页加载状态的间隔 */
var TAB_READY_POLL_MS = 200;

/**
 * 等待目标标签页加载完成。
 *
 * 背景：Content Script 在每条回复提取完成后会把页面整页跳转到「新对话页」，
 * 此时标签页处于 loading 状态。若下一条请求恰好紧跟着到达，直接注入 content script
 * 可能落到正在卸载的旧文档上而失败。这里在下发任务前先等标签页 ready。
 *
 * @param {number} tabId 标签页 id
 * @returns {Promise<void>} 标签页 ready 或超时后 resolve（不阻塞，交由后续流程处理）
 */
function waitForTabReady(tabId) {
  return new Promise(function (resolve) {
    var deadline = Date.now() + TAB_READY_TIMEOUT_MS;
    function check() {
      chrome.tabs.get(tabId, function (tab) {
        if (chrome.runtime.lastError || !tab) {
          // 标签页已关闭等异常：直接返回，交由后续流程报错
          resolve();
          return;
        }
        if (tab.status !== 'loading' || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, TAB_READY_POLL_MS);
      });
    }
    check();
  });
}

/**
 * 向指定标签页的 content script 发送消息。
 * @param {number} tabId 标签页 id
 * @param {Object} message 消息内容
 * @returns {boolean} 是否成功投递
 */
function sendToContent(tabId, message) {
  var port = contentPorts.get(tabId);
  if (port) {
    try {
      port.postMessage(message);
      return true;
    } catch (err) {
      contentPorts.delete(tabId);
    }
  }
  chrome.tabs.sendMessage(tabId, message).catch(function () {
    // 页面尚未注入或已卸载，忽略
  });
  return true;
}

/**
 * 处理网关下发的执行指令。
 * @param {Object} message execute 消息
 */
function handleExecute(message) {
  executeTask({
    requestId: message.request_id,
    prompt: message.prompt,
    host: (message.profile && message.profile.host) || '',
    timeoutMs: message.timeout_ms || 180000,
    reporter: function (payload) {
      send(Object.assign({ v: 1, request_id: message.request_id }, payload));
    }
  });
}

/**
 * 执行一次对话任务。
 * @param {Object} options 任务参数，包含 requestId、prompt、host、timeoutMs、reporter
 */
function executeTask(options) {
  if (state.currentTask) {
    options.reporter({ type: 'error', code: 'browser_busy', message: '已有任务在执行，请稍后重试' });
    return;
  }

  findTargetTab(options.host).then(function (tab) {
    if (!tab || !tab.id) {
      options.reporter({
        type: 'error',
        code: 'tab_not_found',
        message: options.host ? '未找到已打开的 ' + options.host + ' 标签页' : '未找到可用的浏览器标签页'
      });
      return null;
    }
    // 顺序很关键：
    //   1) 若上一轮留下了「需要开启新对话」标记，先完成导航并等新文档就绪；
    //   2) 再等标签页加载完成，避免 content script 落到正在卸载的旧文档上。
    // 导航必须在任务下发之前完成，否则会与紧接着到达的下一轮请求抢跑。
    return resetConversationIfNeeded(tab.id)
      .then(function () {
        return waitForTabReady(tab.id);
      })
      .then(function () {
        return ensureContentScript(tab.id);
      })
      .then(function (ready) {
        if (!ready) {
          options.reporter({
            type: 'error',
            code: 'injection_failed',
            message: '目标页面无法注入 content script（可能仍在加载或页面受限），请稍后重试'
          });
          return null;
        }
        return ensureInjected(tab.id).then(function () {
          return getProfile(hostOf(tab.url || ''));
        });
      })
      .then(function (profile) {
        if (!profile) {
          return; // 上一步已上报错误，短路结束
        }
        if (!profile.inputSelector) {
          // 不直接报错：content script 会尝试自动识别输入框，失败时才上报 selector_missing
          console.info('[oap] 站点 ' + hostOf(tab.url || '') + ' 未配置输入框选择器，将尝试自动识别');
        }

        var task = {
          requestId: options.requestId,
          tabId: tab.id,
          startedAt: Date.now(),
          timeoutMs: options.timeoutMs,
          reporter: options.reporter,
          netTimer: setTimeout(function () {
            armDebugger(tab.id, profile.responseUrlPattern || '');
          }, NETWORK_GRACE_MS),
          networkSeen: false,
          chunks: [],
          accepted: false,
          retried: false,
          acceptedTimer: null,
          taskTimer: null,
          runMessage: null
        };
        state.currentTask = task;

        // 任务硬超时兜底：即便 content script 因任何原因彻底失联（页面被关掉、刷新中途、
        // 脚本异常），也能释放 currentTask，避免后续请求被 browser_busy 永久拒绝。
        task.taskTimer = setTimeout(function () {
          if (state.currentTask === task) {
            failCurrentTask('browser_timeout', '浏览器侧任务超时未完成，已强制释放（避免后续请求被拒）');
          }
        }, (options.timeoutMs || 180000) + TASK_HARD_TIMEOUT_GRACE_MS);

        dispatchRun(task, profile, options.prompt);
      });
  });
}

/**
 * 若该标签页被标记「下一轮前需要开启新对话」，则导航回站点根路径并等新页面就绪。
 *
 * 为什么要由本侧主导：若让 content script 在回传结果后自行整页跳转，跳转会与客户端
 * 紧接着发起的下一轮请求形成竞态——跳转尚未起步时 `tab.status` 仍是 complete，等待逻辑
 * 会立即放行，任务被投递到正在卸载的旧文档后无声丢失（表现为「工具执行后不再继续发送」）。
 * 改为「任务到来时才导航」，即可保证「导航 → 等就绪 → 下发任务」严格串行。
 *
 * 导航失败只记录告警、不阻断任务（尽力而为，退回旧会话继续）。
 *
 * @param {number} tabId 标签页 id
 * @returns {Promise<void>} 无需重置、或重置流程结束后 resolve
 */
function resetConversationIfNeeded(tabId) {
  if (state.pendingNewChat !== tabId) {
    return Promise.resolve();
  }
  state.pendingNewChat = null;
  return new Promise(function (resolve) {
    chrome.tabs.get(tabId, function (tab) {
      if (chrome.runtime.lastError || !tab || !tab.url) {
        console.warn('[oap] 会话重置跳过：无法读取标签页信息');
        resolve();
        return;
      }
      var origin = '';
      try {
        origin = new URL(tab.url).origin;
      } catch (err) {
        origin = '';
      }
      if (!origin || origin === 'null') {
        console.warn('[oap] 会话重置跳过：无法解析站点根路径');
        resolve();
        return;
      }
      var target = origin + '/';
      var since = Date.now();
      console.info('[oap] 会话重置：导航到新对话页 ' + target);
      chrome.tabs.update(tabId, { url: target }, function () {
        if (chrome.runtime.lastError) {
          console.warn('[oap] 会话重置导航失败：' + chrome.runtime.lastError.message);
          resolve();
          return;
        }
        waitForFreshContentScript(tabId, since).then(function (ready) {
          if (ready) {
            console.info('[oap] 会话重置完成：新对话页已就绪');
          } else {
            console.warn('[oap] 会话重置等待超时：新页面 content script 未就绪，仍继续下发（可能失败）');
          }
          resolve();
        });
      });
    });
  });
}

/**
 * 等待指定标签页出现「晚于 since 的 hello 上报」，即新文档的 content script 已就绪。
 *
 * 用 hello 而不是 tab.status 判断就绪：status 变为 complete 只说明主文档加载完成，
 * 此刻 content script 未必已注入并建立连接；hello 才是新脚本真正可接收指令的明确信号。
 *
 * @param {number} tabId 标签页 id
 * @param {number} since 起始时间戳（导航发起时刻）
 * @returns {Promise<boolean>} 在超时前收到 hello 返回 true
 */
function waitForFreshContentScript(tabId, since) {
  return new Promise(function (resolve) {
    var deadline = Date.now() + NAV_SETTLE_TIMEOUT_MS;
    function check() {
      var hello = state.lastHello;
      if (hello && hello.tabId === tabId && hello.at >= since) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    }
    check();
  });
}

/**
 * 下发 run 指令，并在收不到 content script 的 accepted 回执时重试一次。
 *
 * 指令投递是「尽力而为」的：若目标文档正在卸载，`port.postMessage` 可能投到旧文档，
 * `chrome.tabs.sendMessage` 失败也会被 catch 吞掉。因此必须自己等回执——超时重试一次，
 * 仍无回执就报错并释放任务，避免 currentTask 永久悬挂把扩展卡死。
 *
 * @param {Object} task 任务对象
 * @param {Object} profile 站点配置
 * @param {string} prompt 提示词
 */
function dispatchRun(task, profile, prompt) {
  task.runMessage = {
    action: 'run',
    requestId: task.requestId,
    prompt: prompt,
    timeoutMs: task.timeoutMs,
    profile: profile
  };
  sendToContent(task.tabId, task.runMessage);
  scheduleAcceptTimeout(task);
}

/**
 * 安排「等待 accepted 回执」的定时器：超时先重试下发一次，再超时则判定失败并释放任务。
 * @param {Object} task 任务对象
 */
function scheduleAcceptTimeout(task) {
  if (task.acceptedTimer) {
    clearTimeout(task.acceptedTimer);
  }
  task.acceptedTimer = setTimeout(function () {
    if (state.currentTask !== task) {
      return;
    }
    if (task.retried) {
      failCurrentTask('accepted_timeout', '指令未能送达页面（content script 未确认接收），请重试');
      return;
    }
    task.retried = true;
    console.warn('[oap] 未收到 content script 的 accepted 回执，重试下发一次');
    sendToContent(task.tabId, task.runMessage);
    scheduleAcceptTimeout(task);
  }, ACCEPT_TIMEOUT_MS);
}

/**
 * 处理取消指令。
 * @param {string} requestId 任务 id
 */
function handleCancel(requestId) {
  if (!state.currentTask || state.currentTask.requestId !== requestId) {
    return;
  }
  sendToContent(state.currentTask.tabId, { action: 'cancel', requestId: requestId });
  failCurrentTask('cancelled', '任务已被调用方取消');
}

/**
 * 结束当前任务（失败路径）。
 * @param {string} code 错误码
 * @param {string} message 错误描述
 */
function failCurrentTask(code, message) {
  var task = state.currentTask;
  if (!task) {
    return;
  }
  clearTaskTimers(task);
  state.currentTask = null;
  detachDebugger(task.tabId);
  task.reporter({ type: 'error', code: code, message: message });
  broadcastStatus();
}

/**
 * 结束当前任务（成功路径）。
 *
 * 工具调用**不再由扩展解析**：整段回答（自然语言或工具调用 JSON）原样透传给网关，
 * 由客户端解析并执行。原因：客户端解析器会用括号配对判断 JSON 是否闭合，能可靠拒绝
 * 「半截 JSON」；而扩展侧原先的宽松正则会把未输出完的片段当成完整调用直接送执行。
 *
 * @param {string} text 完整回答文本
 * @param {string} finishReason 结束原因
 */
function finishCurrentTask(text, finishReason) {
  var task = state.currentTask;
  if (!task) {
    return;
  }
  clearTaskTimers(task);
  state.currentTask = null;
  detachDebugger(task.tabId);
  console.log('[oap] finishCurrentTask: text_length=' + (text ? text.length : 0) +
              ' finish_reason=' + finishReason);
  task.reporter({ type: 'done', text: text, finish_reason: finishReason || 'stop' });
  broadcastStatus();
}

/**
 * 清理任务的定时器。
 * @param {Object} task 任务对象
 */
function clearTaskTimers(task) {
  if (!task) {
    return;
  }
  if (task.netTimer) {
    clearTimeout(task.netTimer);
    task.netTimer = null;
  }
  if (task.acceptedTimer) {
    clearTimeout(task.acceptedTimer);
    task.acceptedTimer = null;
  }
  if (task.taskTimer) {
    clearTimeout(task.taskTimer);
    task.taskTimer = null;
  }
}

// ------------------------------------------------------------ content 上报处理

/**
 * 处理 content script 上报的消息。
 * @param {Object} message 上报内容
 * @param {number} tabId 来源标签页
 */
function onContentMessage(message, tabId) {
  if (!message || !message.action) {
    return;
  }
  var task = state.currentTask;

  if (message.action === 'hello') {
    // 记录新文档 content script 的就绪时刻：会话重置导航后据此等待新页面可用
    state.lastHello = { tabId: tabId, at: Date.now() };
    broadcastStatus();
    return;
  }
  if (!task) {
    return;
  }

  switch (message.action) {
    case 'log':
      console.info('[oap] ' + message.message);
      return;
    case 'accepted':
      // content script 已确认接收任务：清掉「等待回执」定时器，任务转入正常流程
      if (task.requestId !== message.requestId) {
        return;
      }
      task.accepted = true;
      if (task.acceptedTimer) {
        clearTimeout(task.acceptedTimer);
        task.acceptedTimer = null;
      }
      return;
    case 'net_signal':
    case 'net_done':
      if (task.tabId !== tabId) {
        return;
      }
      task.networkSeen = true;
      if (task.netTimer) {
        clearTimeout(task.netTimer);
        task.netTimer = null;
      }
      return;
    case 'chunk':
      // CRX 已改为「攒完整结果后一次性回传」，正常不会收到增量块。
      // 此处仅作防御性处理：标记网络活动，不再向网关转发增量。
      if (task.requestId !== message.requestId) {
        return;
      }
      task.networkSeen = true;
      if (task.netTimer) {
        clearTimeout(task.netTimer);
        task.netTimer = null;
      }
      return;
    case 'done':
      if (task.requestId !== message.requestId) {
        return;
      }
      // content 带回「下一轮前需要开启新对话」标记：等下一次任务到来时由本侧导航，
      // 使「导航 → 等就绪 → 下发」严格串行，不会与紧接而来的下一轮请求抢跑。
      if (message.needNewChat) {
        state.pendingNewChat = tabId;
      }
      finishCurrentTask(message.text || '', message.finishReason);
      return;
    case 'error':
      if (task.requestId !== message.requestId) {
        return;
      }
      failCurrentTask(message.code || 'internal_error', message.message || '页面执行失败');
      return;
    default:
      break;
  }
}

// ------------------------------------------------------------------ debugger 降级

/**
 * 挂载 debugger，用于在网络嗅探失效时判定响应结束。
 * @param {number} tabId 标签页 id
 * @param {string} pattern 响应 URL 匹配规则
 */
function armDebugger(tabId, pattern) {
  if (state.debugSession) {
    return;
  }
  var target = { tabId: tabId };
  chrome.debugger
    .attach(target, DEBUGGER_VERSION)
    .then(function () {
      return chrome.debugger.sendCommand(target, 'Network.enable', {
        maxPostDataSize: 0,
        maxResourceBufferSize: 5 * 1024 * 1024,
        maxTotalBufferSize: 20 * 1024 * 1024
      });
    })
    .then(function () {
      state.debugSession = { tabId: tabId, tracked: new Set(), pattern: pattern || '' };
      console.info('[oap] 网络嗅探未生效，已降级启用 debugger 抓包');
    })
    .catch(function (err) {
      console.warn('[oap] debugger 挂载失败：', err);
      state.debugSession = null;
    });
}

/**
 * 卸载 debugger。
 * @param {number} tabId 标签页 id
 */
function detachDebugger(tabId) {
  if (!state.debugSession || state.debugSession.tabId !== tabId) {
    return;
  }
  state.debugSession = null;
  chrome.debugger.detach({ tabId: tabId }).catch(function () {
    // 目标可能已关闭，忽略
  });
}

/**
 * 处理 CDP 事件，仅关注目标请求的生命周期。
 * @param {{tabId: number}} source 调试目标
 * @param {string} method 事件名
 * @param {Object} params 事件参数
 */
function onDebuggerEvent(source, method, params) {
  var session = state.debugSession;
  if (!session || !source || source.tabId !== session.tabId || !params) {
    return;
  }
  if (method === 'Network.responseReceived') {
    var url = (params.response && params.response.url) || '';
    if (matchesUrl(url, session.pattern)) {
      session.tracked.add(params.requestId);
    }
    return;
  }
  if (method === 'Network.dataReceived') {
    if (session.tracked.has(params.requestId)) {
      sendToContent(session.tabId, { action: 'net_signal_external' });
    }
    return;
  }
  if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    if (session.tracked.has(params.requestId)) {
      session.tracked.delete(params.requestId);
      // 只有「所有被跟踪的请求都已结束」才判定流结束。
      // 被跟踪的集合里常同时包含思考流、会话查询、心跳等辅助请求，任一结束就上报
      // 会让 content 误判为「答案已生成完毕」，从而把仍在生成的回答截断
      //（表现为「生成到一半就结束」）。待集合清空再上报可保证等到最长的那条流。
      if (session.tracked.size === 0) {
        sendToContent(session.tabId, { action: 'net_done_external' });
        detachDebugger(session.tabId);
      }
    }
  }
}

/**
 * 处理 debugger 被卸载（标签页关闭或用户手动取消）。
 * @param {{tabId: number}} source 调试目标
 */
function onDebuggerDetach(source) {
  if (state.debugSession && source && state.debugSession.tabId === source.tabId) {
    state.debugSession = null;
  }
}

// ------------------------------------------------------------------ 弹窗与状态

/**
 * 构造当前状态快照，供弹窗展示。
 * @returns {Object} 状态对象
 */
function buildStatus() {
  var task = state.currentTask;
  return {
    connected: state.connected,
    gatewayUrl: state.gatewayUrl,
    sessionId: state.sessionId,
    clientId: state.clientId,
    debuggerAttached: state.debugSession !== null,
    task: task ? { requestId: task.requestId, tabId: task.tabId, elapsed: Date.now() - task.startedAt } : null,
    version: chrome.runtime.getManifest().version
  };
}

/**
 * 向所有打开的弹窗推送状态。
 */
function broadcastStatus() {
  var status = buildStatus();
  popupPorts.forEach(function (port) {
    try {
      port.postMessage({ action: 'status', status: status });
    } catch (err) {
      popupPorts.delete(port);
    }
  });
}

/**
 * 处理弹窗发来的指令。
 * @param {Object} message 指令内容
 * @param {chrome.runtime.Port} port 来源端口
 */
function onPopupMessage(message, port) {
  if (!message || !message.action) {
    return;
  }
  switch (message.action) {
    case 'get_status':
      port.postMessage({ action: 'status', status: buildStatus() });
      break;
    case 'get_profile':
      getProfile(message.host || '').then(function (profile) {
        port.postMessage({ action: 'profile', host: message.host || '', profile: profile });
      });
      break;
    case 'save_profile':
      saveProfile(message.host || '', message.profile || {}).then(function (ok) {
        port.postMessage({ action: 'saved', ok: ok, host: message.host || '' });
      });
      break;
    case 'set_gateway':
      chrome.storage.local.set({ gatewayUrl: message.url || DEFAULT_GATEWAY_URL }, function () {
        loadSettings().then(function () {
          if (state.socket) {
            try {
              state.socket.close();
            } catch (err) {
              // 已关闭，忽略
            }
          }
          state.attempt = 0;
          ensureConnected();
          port.postMessage({ action: 'gateway_saved', url: state.gatewayUrl });
        });
      });
      break;
    case 'test_run':
      runLocalTest(message, port);
      break;
    default:
      break;
  }
}

/**
 * 执行一次本地测试任务：不经过网关，直接驱动页面并把结果回传弹窗。
 * @param {Object} message 测试参数，包含 host 与 text
 * @param {chrome.runtime.Port} port 弹窗端口
 */
function runLocalTest(message, port) {
  var requestId = 'test-' + randomId();
  executeTask({
    requestId: requestId,
    prompt: message.text || '你好，请回复一句“连接成功”。',
    host: message.host || '',
    timeoutMs: 120000,
    reporter: function (payload) {
      try {
        port.postMessage(Object.assign({ action: 'test_event' }, payload));
      } catch (err) {
        // 弹窗已关闭，忽略
      }
    }
  });
}

// ------------------------------------------------------------------ 事件注册

chrome.runtime.onInstalled.addListener(function () {
  loadSettings().then(ensureConnected);
});

chrome.runtime.onStartup.addListener(function () {
  loadSettings().then(ensureConnected);
});

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm && alarm.name === KEEPALIVE_ALARM) {
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      send({ v: 1, type: 'heartbeat', ts: Date.now() });
    } else {
      loadSettings().then(ensureConnected);
    }
  }
});

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name === 'oap-content') {
    var tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
    if (tabId === null) {
      return;
    }
    contentPorts.set(tabId, port);
    port.onMessage.addListener(function (message) {
      onContentMessage(message, tabId);
    });
    port.onDisconnect.addListener(function () {
      // 仅当映射里存的仍是这个 port 时才删除：页面刷新时旧文档的 disconnect 可能
      // 晚于新文档的 connect 到达，无条件删除会把刚建立的新 port 一并清掉。
      if (contentPorts.get(tabId) === port) {
        contentPorts.delete(tabId);
      }
    });
    return;
  }
  if (port.name === 'oap-popup') {
    popupPorts.add(port);
    port.onMessage.addListener(function (message) {
      onPopupMessage(message, port);
    });
    port.onDisconnect.addListener(function () {
      popupPorts.delete(port);
    });
  }
});

// 兼容 content script 使用一次性消息上报的场景
chrome.runtime.onMessage.addListener(function (message, sender) {
  onContentMessage(message, sender && sender.tab ? sender.tab.id : null);
  return false;
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  contentPorts.delete(tabId);
  if (state.currentTask && state.currentTask.tabId === tabId) {
    failCurrentTask('tab_not_found', '目标标签页已关闭');
  }
  if (state.debugSession && state.debugSession.tabId === tabId) {
    state.debugSession = null;
  }
});

// debugger 监听器必须在顶层同步注册，否则 Service Worker 重启后会丢失事件
chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);

// ------------------------------------------------------------------ 启动

loadSettings().then(function () {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  ensureConnected();
});
