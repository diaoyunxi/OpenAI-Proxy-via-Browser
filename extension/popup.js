/**
 * popup.js —— 扩展弹窗交互逻辑。
 *
 * 提供：网关地址配置、按站点维护选择器、网关连通性自测、一次完整的发送联调。
 * 弹窗打开期间会与 Service Worker 保持长连接，并按固定间隔发送状态请求，
 * 这有助于维持 Service Worker 存活（Manifest V3 的空闲回收阈值约 30 秒）。
 */
'use strict';

/** 与 Service Worker 的持久连接 */
var port = null;
/** 当前弹窗所针对的站点域名 */
var currentHost = '';
/** 保活定时器句柄 */
var keepAliveTimer = null;
/** 测试任务是否正在进行 */
var testing = false;

/**
 * 获取页面元素引用。
 * @param {string} id 元素 id
 * @returns {HTMLElement} 元素对象
 */
function $(id) {
  return document.getElementById(id);
}

/**
 * 更新连接状态指示灯。
 * @param {Object} status 状态对象
 */
function renderStatus(status) {
  var dot = $('status-dot');
  var text = $('status-text');
  dot.className = 'dot ' + (status.connected ? 'dot-on' : 'dot-wait');
  if (status.connected) {
    text.textContent = '已连接网关' + (status.debuggerAttached ? '（debugger 已挂载）' : '');
  } else {
    text.textContent = '未连接网关，正在重试…';
  }
  $('version-text').textContent = '扩展版本 ' + (status.version || '未知');
  $('gateway-url').value = status.gatewayUrl || '';
}

/**
 * 把站点配置填充到表单。
 * @param {Object} profile 站点配置
 */
function renderProfile(profile) {
  $('input-selector').value = profile.inputSelector || '';
  $('send-selector').value = profile.sendSelector || '';
  $('response-selector').value = profile.responseSelector || '';
  $('url-pattern').value = profile.responseUrlPattern || '';
}

/**
 * 收集表单中的站点配置。
 * @returns {Object} 站点配置对象
 */
function collectProfile() {
  return {
    inputSelector: $('input-selector').value.trim(),
    sendSelector: $('send-selector').value.trim(),
    responseSelector: $('response-selector').value.trim(),
    responseUrlPattern: $('url-pattern').value.trim()
  };
}

/**
 * 由 WebSocket 地址推导健康检查地址。
 * @param {string} wsUrl WebSocket 地址
 * @returns {string} HTTP 健康检查地址
 */
function toHealthUrl(wsUrl) {
  var url = String(wsUrl || '').replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  url = url.replace(/\/ws\/?$/, '/health');
  if (url.indexOf('/health') === -1) {
    url = url.replace(/\/+$/, '') + '/health';
  }
  return url;
}

/**
 * 测试网关 HTTP 接口是否可达。
 */
function testConnection() {
  var result = $('conn-result');
  var url = toHealthUrl($('gateway-url').value.trim());
  result.textContent = '测试中…';
  fetch(url, { method: 'GET' })
    .then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return data;
      });
    })
    .then(function (data) {
      var connected = data && data.browser_connected;
      result.textContent = '网关正常，浏览器' + (connected ? '已连接' : '未连接');
      result.style.color = connected ? '#16a34a' : '#d97706';
    })
    .catch(function (err) {
      result.textContent = '无法访问网关：' + (err && err.message ? err.message : err);
      result.style.color = '#dc2626';
    });
}

/**
 * 建立与 Service Worker 的持久连接并注册消息处理。
 */
function connectPort() {
  port = chrome.runtime.connect({ name: 'oap-popup' });
  port.onMessage.addListener(function (message) {
    if (!message || !message.action) {
      return;
    }
    if (message.action === 'status') {
      renderStatus(message.status);
      return;
    }
    if (message.action === 'profile') {
      renderProfile(message.profile || {});
      return;
    }
    if (message.action === 'saved') {
      $('save-result').textContent = message.ok ? '已保存' : '保存失败';
      setTimeout(function () {
        $('save-result').textContent = '';
      }, 2000);
      return;
    }
    if (message.action === 'gateway_saved') {
      $('conn-result').textContent = '地址已保存，正在重连…';
      return;
    }
    if (message.action === 'test_event') {
      handleTestEvent(message);
    }
  });
  port.onDisconnect.addListener(function () {
    port = null;
  });

  port.postMessage({ action: 'get_status' });
  if (currentHost) {
    port.postMessage({ action: 'get_profile', host: currentHost });
  }

  // 每 20 秒发一次状态请求，兼顾状态刷新与 Service Worker 保活
  keepAliveTimer = setInterval(function () {
    if (port) {
      try {
        port.postMessage({ action: 'get_status' });
      } catch (err) {
        port = null;
      }
    }
  }, 20000);
}

/**
 * 处理测试任务的事件流。
 * @param {Object} message 事件消息
 */
function handleTestEvent(message) {
  var state = $('test-state');
  var output = $('test-output');

  if (message.type === 'chunk') {
    output.textContent += message.text || '';
    output.scrollTop = output.scrollHeight;
    return;
  }
  if (message.type === 'done') {
    testing = false;
    state.textContent = '完成（' + (message.finish_reason || 'stop') + '）';
    state.style.color = '#16a34a';
    return;
  }
  if (message.type === 'error') {
    testing = false;
    state.textContent = '失败：' + (message.message || message.code || '未知错误');
    state.style.color = '#dc2626';
    output.textContent = output.textContent || '（无内容）\n错误码：' + (message.code || 'unknown');
  }
}

/**
 * 绑定页面上的全部交互事件。
 */
function bindEvents() {
  $('btn-save-gateway').addEventListener('click', function () {
    var url = $('gateway-url').value.trim();
    if (!url) {
      $('conn-result').textContent = '地址不能为空';
      return;
    }
    if (port) {
      port.postMessage({ action: 'set_gateway', url: url });
    }
  });

  $('btn-test-conn').addEventListener('click', testConnection);

  $('btn-save-profile').addEventListener('click', function () {
    if (!currentHost) {
      $('save-result').textContent = '未能识别当前站点';
      return;
    }
    var profile = collectProfile();
    if (!profile.inputSelector) {
      $('save-result').textContent = '输入框选择器为必填项';
      return;
    }
    if (port) {
      port.postMessage({ action: 'save_profile', host: currentHost, profile: profile });
    }
  });

  $('btn-test-run').addEventListener('click', function () {
    if (testing) {
      return;
    }
    if (!currentHost) {
      $('test-state').textContent = '未能识别当前站点';
      return;
    }
    testing = true;
    $('test-state').textContent = '执行中…';
    $('test-state').style.color = '#6b7280';
    $('test-output').textContent = '';
    if (port) {
      port.postMessage({
        action: 'test_run',
        host: currentHost,
        text: $('test-text').value
      });
    }
  });
}

/**
 * 初始化：识别当前站点并连接 Service Worker。
 */
function init() {
  bindEvents();
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab && tab.url) {
      try {
        currentHost = new URL(tab.url).hostname;
      } catch (err) {
        currentHost = '';
      }
    }
    $('current-host').textContent = currentHost || '未识别';
    connectPort();
  });
}

document.addEventListener('DOMContentLoaded', init);
