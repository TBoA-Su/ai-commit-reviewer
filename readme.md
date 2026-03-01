# AI Commit Reviewer

一个 VS Code 插件，利用 AI 模型对 Git Commit 的代码变更进行智能审核和质量评估。

## 功能特性

- 🤖 **AI 智能审核**：支持 OpenAI、Claude、通义千问、DeepSeek 等多种 AI 模型
- 📊 **分步审核流程**：先预览代码变更，确认后再发送给 AI 评估
- 📝 **代码差异高亮**：Git diff 语法高亮，清晰展示增删改
- 🎯 **质量维度分析**：从代码质量、潜在问题、性能、安全性、改进建议五个维度评估
- ⚙️ **灵活配置**：支持任意兼容 OpenAI API 格式的模型
- 🔒 **安全存储**：API Key 安全存储在 VS Code 配置中

## 安装

### 本地安装

1. 克隆或下载本仓库

2. 安装依赖：
  ```bash
  npm install
  ```

3. 编译：
  ```bash
  npm run compile
  ```

4. 按 F5 启动调试，或打包安装：
  ```bash
  npm install -g vsce
  vsce package
  # 然后在 VS Code 中安装生成的 .vsix 文件
  ```

## 配置

1. 点击左侧活动栏的 Git Pull Request 图标打开插件

2. 切换到 设置 页面

3. 填写以下信息：

| 配置项   | 说明               | 示例                                         |
| -------- | ------------------ | -------------------------------------------- |
| API 地址 | AI 服务的 API 端点 | `https://api.openai.com/v1/chat/completions` |
| API Key  | 你的 API 密钥      | `sk-xxxxxxxxxxxxxxxx`                        |
| 模型名称 | 使用的 AI 模型     | `gpt-4`、`claude-3-sonnet-20240229`          |

## 支持的模型

- OpenAI：gpt-4、gpt-4-turbo、gpt-4o、gpt-4o-mini、gpt-3.5-turbo

- Claude：claude-3-opus-20240229、claude-3-sonnet-20240229、claude-3-haiku-20240307

- 通义千问：qwen-turbo、qwen-max

- DeepSeek：deepseek-chat、deepseek-coder

- 本地模型：llama3-8b、llama3-70b 等（通过 Ollama 等工具部署）

- 其他：任意兼容 OpenAI API 格式的模型

## 配置示例

OpenAI：
  ```
  API 地址：https://api.openai.com/v1/chat/completions
  API Key：sk-xxxxxxxxxxxxxxxx
  模型：gpt-4
  ```

Azure OpenAI：
  ```
  API 地址：https://your-resource.openai.azure.com/openai/deployments/your-deployment/chat/completions?api-version=2024-02-15-preview
  API Key：your-azure-api-key
  模型：gpt-4
  ```

本地 Ollama：
  ```
  API 地址：http://localhost:11434/v1/chat/completions
  API Key：ollama（任意值，Ollama 不验证）
  模型：llama3
  ```

## 使用

审核流程

1. 获取代码变更

   - 在 代码审核 页面点击「📥 获取代码变更」

   - 插件会自动检测：
     - 最近一次 commit 的变更（HEAD~1 → HEAD）
     - 暂存区的变更（staged changes）
     - 工作区的变更（working tree）

2. 预览变更

    - 查看变更统计（文件数、新增/删除行数）
    - 查看 diff 内容（语法高亮显示）
    - 确认无误后点击「🤖 发送给 AI 评估」

3. 查看审核结果

   - AI 从五个维度分析代码质量
   - 标注问题严重程度（严重/警告/建议）
   - 提供具体改进建议

4. 开始新的审核

   - 点击「🔄 开始新的审核」重置流程

快捷键

- 点击左侧活动栏图标打开插件
- 支持命令面板（Ctrl+Shift+P）搜索 "AI Commit Reviewer"

## 常见问题

Q: 提示"没有检测到代码变更"

A: 可能原因：

- 当前没有 staged changes
- 这是仓库的第一个提交（没有 parent commit）
- 最近 commit 是空提交或合并提交

解决：确保至少有两个 commit，或先暂存一些更改（git add .）

Q: API 请求失败

A: 检查：

- API 地址是否正确（注意区分 chat completions 和 completions 端点）
- API Key 是否有效
- 模型名称是否正确
- 网络连接是否正常

Q: 如何更换模型？

A: 在设置页面直接输入新的模型名称，支持任意自定义模型。

Q: 审核结果不满意？

A: 可以在设置中尝试更强的模型（如 GPT-4、Claude-3 Opus），或调整代码后重新审核。

## 技术细节

- 前端：VS Code Webview API + 原生 JavaScript
- Git 操作：Node.js child_process 执行 Git 命令
- AI 调用：Fetch API 调用兼容 OpenAI 格式的接口
- 类型安全：TypeScript 开发

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听修改
npm run watch

# 调试
按 F5 启动 Extension Development Host
```
