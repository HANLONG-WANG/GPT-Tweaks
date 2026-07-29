# GPT Tweaks

一个面向 ChatGPT 网页版的轻量浏览器扩展。目前只提供一个功能：将发送快捷键从 `Enter` 改为 `Ctrl+Enter`，避免输入过程中误发送。

## 按键行为

| 按键 | 行为 |
| --- | --- |
| `Enter` | 插入换行，不发送 |
| `Shift+Enter` | 保留 ChatGPT 原生换行行为 |
| `Ctrl+Enter` | 发送当前消息 |
| 输入法选字时按 `Enter` | 不干预输入法 |

为了确保只有 `Ctrl+Enter` 负责发送，`Alt+Enter`、`Cmd+Enter` 等其他不含 `Shift` 的 Enter 组合也会被处理为换行。

## 安装

本项目无需构建，可以直接作为“已解压的扩展程序”加载。

### Chrome

1. 下载或克隆本仓库。
2. 在地址栏打开 `chrome://extensions/`。
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目根目录，也就是包含 `manifest.json` 的目录。
6. 打开或刷新 `https://chatgpt.com/`。

### Edge

安装步骤与 Chrome 相同，扩展管理页面地址为 `edge://extensions/`。

## 手动验证

加载扩展并刷新 ChatGPT 页面后，可以按以下顺序检查：

1. 在输入框中输入两段文字，中间按一次 `Enter`，确认只产生换行。
2. 按 `Shift+Enter`，确认仍能正常换行。
3. 输入一段不会造成实际影响的测试文字，按 `Ctrl+Enter`，确认消息被发送。
4. 使用中文或日文输入法选字时按 `Enter`，确认可以正常上屏且不会发送。

修改扩展文件后，请在扩展管理页面点击本扩展的“重新加载”，并刷新 ChatGPT 页面。

## 文件说明

```text
.
├── manifest.json  # Manifest V3 配置
├── content.js     # 键盘事件与发送逻辑
└── README.md      # 安装及使用说明
```

## 实现说明

- 扩展仅在 `chatgpt.com` 域名下注入脚本。
- 在键盘事件的捕获阶段拦截 ChatGPT 的默认发送行为。
- 普通 `Enter` 会被转换为 `Shift+Enter`，复用 ChatGPT 编辑器原生的换行逻辑，不直接修改输入框 DOM。
- 使用 ChatGPT 的 `#prompt-textarea` 与 `data-testid="send-button"` 定位元素，不依赖随机生成的 CSS 类名。
- 扩展不申请额外权限，不读取或保存对话内容，也不会向第三方发送数据。

如果 ChatGPT 后续修改输入框或发送按钮的页面结构，相关选择器可能需要同步更新。
