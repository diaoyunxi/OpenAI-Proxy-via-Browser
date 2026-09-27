Chrome 扩展程序的开发规范，目前的核心是 **Manifest V3**。下面是一份详尽的规范说明。

### 📜 核心：清单文件 (manifest.json)

这是扩展程序的“蓝图”，一个必需的 JSON 格式文件，包含了扩展程序所有的关键信息、权限和功能定义。

#### 基础必填字段
这些字段是所有扩展程序的“身份证”。

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| **`manifest_version`** | 整数 | **必须**设为 `3`，代表使用最新的 Manifest V3 规范。 |
| **`name`** | 字符串 | 扩展程序的名称，会显示在浏览器工具栏和 Chrome 网上应用店中。 |
| **`version`** | 字符串 | 扩展程序的版本号，用于管理更新。 |

#### 关键功能字段
这些字段定义了扩展程序能做什么。

**1. 后台（Background）**
- **规范**：使用 `"background": { "service_worker": "background.js" }`。
- **说明**：`service_worker` 是一个在后台持续运行的事件处理程序，取代了旧版 V2 中的后台页面。它是扩展程序的大脑，负责监听和响应各种浏览器事件，但不能直接操作网页 DOM。

**2. 内容脚本（Content Scripts）**
- **规范**：使用 `"content_scripts": [ { "matches": ["<all_urls>"], "js": ["content.js"] } ]`。
- **说明**：内容脚本是注入到网页中运行的 JavaScript 文件。它可以读取和修改网页的 DOM，实现与页面的交互。但它只能使用部分 Chrome API，与后台 Service Worker 通信是常用模式。

**3. 权限（Permissions）**
- **规范**：使用 `"permissions": ["storage", "activeTab"]` 和 `"host_permissions": ["https://*/*"]`。
- **说明**：
    - `permissions`：声明扩展程序需要使用的 **Chrome API 权限**，例如 `storage`（存储）、`activeTab`（当前标签页）。
    - `host_permissions`：**声明需要访问的网站**，例如 `"https://*/*"` 表示可访问所有 HTTPS 网站。
    - **最佳实践**：遵循**最小权限原则**，只申请必需的权限。非关键权限可设为 `optional_permissions`，在运行时向用户申请。

**4. 用户界面（User Interface）**
- **`action`（工具栏图标）**：定义扩展程序在浏览器工具栏中的图标和点击行为。
- **`default_popup`**：点击图标时弹出的 HTML 页面（弹窗）。
- **`options_ui`**：扩展程序的设置页面。

**5. 内容安全策略（Content Security Policy, CSP）**
- **规范**：使用 `"content_security_policy"` 键。
- **说明**：CSP 是一项重要的安全机制，用于限制扩展程序可以加载和执行的资源，防止跨站脚本攻击（XSS）等安全问题。Manifest V3 对 CSP 有更严格的限制。

#### 其他重要字段
- **`icons`**：定义扩展程序在不同分辨率下的图标。需要为每个尺寸提供独立的图片文件。
- **`commands`**：定义键盘快捷键。
- **`default_locale`**：如果扩展程序支持多语言，此字段声明默认语言。

### 🧩 核心架构组件

一个典型的 Manifest V3 扩展程序由以下几个核心部分组成:

1.  **Service Worker（后台服务脚本）**：
    - 这是扩展程序的“中枢神经”，负责管理全局状态、监听事件、与其他组件通信。
    - **生命周期**：它在需要时启动，空闲时终止，以节省资源。
    - **能力**：可以调用几乎所有 Chrome API，但**不能直接访问网页 DOM**。

2.  **Content Script（内容脚本）**：
    - 这是扩展程序的“手脚”，被注入到网页中运行。
    - **能力**：可以**读取和修改网页的 DOM**，实现自动化操作。
    - **限制**：只能使用 `chrome.runtime` 等有限 API。

3.  **Action（工具栏图标）与 Popup（弹窗）**：
    - 这是用户与扩展程序交互的主要入口。
    - 点击图标可以触发特定动作（如打开侧边栏）或弹出一个包含界面的 Popup 页面。

4.  **Options Page（选项页面）**：
    - 为用户提供配置扩展程序设置的界面。

### 🔗 组件间通信

由于各组件运行环境隔离，它们需要通过消息传递进行通信。

- **Service Worker ↔ Content Script**：
    - Service Worker 使用 `chrome.tabs.sendMessage()` 向特定标签页中的 Content Script 发送消息。
    - Content Script 使用 `chrome.runtime.sendMessage()` 向 Service Worker 发送消息。
    - 双方通过 `chrome.runtime.onMessage.addListener()` 监听消息。
- **Popup / Options Page ↔ Service Worker**：
    - 与上述方式类似，也通过 `chrome.runtime.sendMessage()` 和 `onMessage` 进行通信。
- **安全实践**：在消息中传递 `extensionId` 可以确保通信只发生在你的扩展程序内部，防止被恶意扩展窃听。

### 🔐 安全规范与最佳实践

开发时必须遵守以下规范以确保扩展程序的安全与稳定。

1.  **禁用远程托管代码**：Manifest V3 **不允许**从远程服务器加载或执行 JavaScript 代码。所有逻辑必须打包在扩展程序内部。
2.  **使用 HTTPS**：所有网络请求都应使用 HTTPS 协议。
3.  **内容安全策略 (CSP)**：通过 `manifest.json` 正确配置 CSP，防止 XSS 等攻击。
4.  **输入验证与数据清洗**：对用户输入和外部来源的数据进行验证和清洗。
5.  **错误处理**：实现完善的错误处理和日志记录。
6.  **最小权限原则**：再次强调，这是最重要的安全实践之一。
7.  **定期更新**：保持代码和依赖库更新，以修复已知的安全漏洞。

### 💎 总结

总的来说，Manifest V3 规范下的 Chrome 扩展程序开发，可以概括为：

1.  **一个核心文件**：`manifest.json`。
2.  **一个后台脚本**：Service Worker，处理事件和逻辑。
3.  **若干内容脚本**：Content Scripts，与网页交互。
4.  **一套权限声明**：明确告知用户所需权限。
5.  **严格的安全策略**：禁止远程代码，强制 CSP。

以上规范是开发稳定、安全、符合 Chrome 网上应用店政策的扩展程序的基础。你可以参考 [Chrome 官方文档](https://developer.chrome.com/docs/extensions/) 来获取更详细的信息。