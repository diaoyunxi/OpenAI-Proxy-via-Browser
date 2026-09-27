/**
 * find-selectors.js —— 在目标 AI 网站上一键探测输入框 / 发送按钮的可用 CSS 选择器。
 *
 * 使用方式：
 *   1. 打开目标站点（如 https://chat.deepseek.com），按 F12 打开 DevTools；
 *   2. 切到 Console 面板，粘贴本文件全部内容并回车；
 *   3. 若 Chrome 提示粘贴被阻止，先手动输入  allow pasting  并回车，再粘贴一次；
 *   4. 脚本会以表格形式列出候选元素，并给出「推荐选择器」与其命中数量。
 *
 * 挑选标准（命中数必须等于 1）：
 *   唯一性：选择器在整个页面上只能匹配到一个元素；
 *   稳定性：优先使用 id / data-* / aria-label 等语义化属性，避开哈希类名与 nth-child。
 */

(function () {
  'use strict';

  /** 稳定属性优先级：越靠前越优先采用 */
  var STABLE_ATTRS = ['data-testid', 'data-test', 'data-e2e', 'data-role', 'data-id'];

  /**
   * 判断元素是否可见。
   * @param {Element} el 待判断元素
   * @returns {boolean} 可见返回 true
   */
  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  /**
   * 统计选择器在页面上的命中数量。
   * @param {string} selector 选择器
   * @returns {number} 命中数量，非法选择器返回 -1
   */
  function countOf(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (err) {
      return -1;
    }
  }

  /**
   * 为元素生成「最稳定且唯一」的短选择器。
   * @param {Element} el 目标元素
   * @returns {string|null} 唯一命中时返回选择器，否则返回 null
   */
  function bestSelector(el) {
    var tag = el.tagName.toLowerCase();

    // 1) id：最可靠，但需排除纯数字或含特殊字符的动态 id
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      var byId = '#' + el.id;
      if (countOf(byId) === 1) {
        return byId;
      }
    }

    // 2) 测试专用 data-* 属性：前端为自动化测试预留，非常稳定
    for (var i = 0; i < STABLE_ATTRS.length; i += 1) {
      var attr = STABLE_ATTRS[i];
      var value = el.getAttribute(attr);
      if (value) {
        var byAttr = tag + '[' + attr + '="' + value + '"]';
        if (countOf(byAttr) === 1) {
          return byAttr;
        }
      }
    }

    // 3) aria-label：无障碍属性，语义明确且很少变动
    var aria = el.getAttribute('aria-label');
    if (aria) {
      var byAria = tag + '[aria-label="' + aria + '"]';
      if (countOf(byAria) === 1) {
        return byAria;
      }
    }

    // 4) 表单元素的 name / placeholder / type
    if (tag === 'input' || tag === 'textarea') {
      if (el.name) {
        var byName = tag + '[name="' + el.name + '"]';
        if (countOf(byName) === 1) {
          return byName;
        }
      }
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) {
        var byPlaceholder = tag + '[placeholder="' + placeholder + '"]';
        if (countOf(byPlaceholder) === 1) {
          return byPlaceholder;
        }
      }
      var byTag = tag === 'textarea' ? 'textarea' : 'input[type="' + el.type + '"]';
      if (countOf(byTag) === 1) {
        return byTag;
      }
    }

    return null;
  }

  /**
   * 输出一组候选元素的探测报告。
   * @param {string} title 报告标题
   * @param {Element[]} nodes 候选元素
   * @returns {string[]} 本组中可直接使用的选择器列表
   */
  function report(title, nodes) {
    console.log('%c=== ' + title + ' ===', 'font-weight:bold;color:#2563eb');
    if (nodes.length === 0) {
      console.log('未找到候选元素');
      return [];
    }

    var rows = [];
    var usable = [];
    nodes.forEach(function (el) {
      var selector = bestSelector(el);
      var rect = el.getBoundingClientRect();
      var dataAttrs = [];
      for (var i = 0; i < el.attributes.length; i += 1) {
        if (el.attributes[i].name.indexOf('data-') === 0) {
          dataAttrs.push(el.attributes[i].name);
        }
      }
      var usable_selector = selector;
      if (usable_selector) {
        usable.push(usable_selector);
      }
      rows.push({
        标签: el.tagName.toLowerCase(),
        id: el.id || '',
        'data-*': dataAttrs.join(',') || '',
        'aria-label': el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        尺寸: Math.round(rect.width) + 'x' + Math.round(rect.height),
        推荐选择器: usable_selector || '（需人工挑选）',
        命中数: usable_selector ? countOf(usable_selector) : '-'
      });
    });

    console.table(rows);
    if (usable.length > 0) {
      console.log('%c可直接使用：', 'color:#16a34a;font-weight:bold', usable.join('   |   '));
    } else {
      console.log('%c本组没有稳定且唯一的选择器，建议人工挑选后手动验证。', 'color:#d97706');
    }
    return usable;
  }

  // ------------------------------------------------------------------ 开始探测

  var inputs = Array.prototype.slice
    .call(document.querySelectorAll('textarea, input[type="text"], input[type="search"], [contenteditable="true"]'))
    .filter(isVisible)
    .filter(function (el) {
      return !el.disabled && !el.readOnly;
    });
  var inputSelectors = report('输入框候选', inputs);

  var buttons = Array.prototype.slice
    .call(document.querySelectorAll('button, [role="button"]'))
    .filter(isVisible);
  var buttonSelectors = report('按钮候选（发送按钮在这里找）', buttons);

  console.log('%c--- 汇总 ---', 'font-weight:bold');
  console.log('输入框可用选择器：', inputSelectors.length ? inputSelectors : '无（可留空，扩展会自动识别）');
  console.log('发送按钮可用选择器：', buttonSelectors.length ? buttonSelectors : '无（可留空，扩展会模拟回车）');
  console.log('把选中的选择器填到扩展弹窗对应字段即可；响应容器建议先留空，交给自动探测。');
})();
