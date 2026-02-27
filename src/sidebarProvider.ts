import * as vscode from 'vscode';
import { getGitDiff, getLastCommitHash } from './git';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;

    constructor(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this._extensionUri = extensionUri;
        this._context = context;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // 处理来自 Webview 的消息
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'saveConfig':
                    await this._saveConfig(data.apiUrl, data.apiKey, data.model);
                    break;
                case 'review':
                    await this._performReview();
                    break;
                case 'getConfig':
                    await this._sendConfigToWebview();
                    break;
            }
        });

        // 初始化时发送配置
        this._sendConfigToWebview();
    }

    private async _sendConfigToWebview() {
        const config = vscode.workspace.getConfiguration('aiCommitReviewer');
        const apiUrl = config.get<string>('apiUrl') || '';
        const apiKey = config.get<string>('apiKey') || '';
        const model = config.get<string>('model') || 'gpt-3.5-turbo';

        this._view?.webview.postMessage({
            type: 'config',
            apiUrl,
            apiKey: apiKey ? '••••••••' : '', // 隐藏真实 key
            model
        });
    }

    private async _saveConfig(apiUrl: string, apiKey: string, model: string) {
        const config = vscode.workspace.getConfiguration('aiCommitReviewer');
        
        // 如果 key 是掩码，保留原值
        let finalKey = apiKey;
        if (apiKey.includes('•') || apiKey === '') {
            const currentKey = config.get<string>('apiKey') || '';
            finalKey = currentKey;
        }

        await config.update('apiUrl', apiUrl, true);
        await config.update('apiKey', finalKey, true);
        await config.update('model', model, true);

        vscode.window.showInformationMessage('配置已保存');
    }

    public async reviewCurrentCommit() {
        await this._performReview();
    }

    public refresh() {
        this._view?.webview.postMessage({ type: 'clear' });
        this._sendConfigToWebview();
    }

    private async _performReview() {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('aiCommitReviewer');
        const apiUrl = config.get<string>('apiUrl');
        const apiKey = config.get<string>('apiKey');
        const model = config.get<string>('model') || 'gpt-3.5-turbo';

        if (!apiUrl || !apiKey) {
            vscode.window.showErrorMessage('请先配置 API 地址和 Key');
            this._view.webview.postMessage({
                type: 'error',
                message: '请先配置 API 地址和 Key'
            });
            return;
        }

        // 获取工作区路径
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('请打开一个工作区');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;

        try {
            this._view.webview.postMessage({ type: 'loading', message: '正在获取代码变更...' });

            // 获取 git diff
            const diff = await getGitDiff(rootPath);
            
            if (!diff || diff.trim() === '') {
                this._view.webview.postMessage({
                    type: 'error',
                    message: '没有检测到代码变更'
                });
                return;
            }

            const commitHash = await getLastCommitHash(rootPath);
            const shortHash = commitHash ? commitHash.substring(0, 7) : 'working tree';

            this._view.webview.postMessage({ 
                type: 'loading', 
                message: `正在审核 ${shortHash} 的代码变更...` 
            });

            // 调用 AI API
            const reviewResult = await this._callAI(apiUrl, apiKey, model, diff);

            this._view.webview.postMessage({
                type: 'reviewResult',
                commitHash: shortHash,
                result: reviewResult,
                diff: diff.substring(0, 2000) + (diff.length > 2000 ? '...' : '') // 截断显示
            });

        } catch (error: any) {
            this._view.webview.postMessage({
                type: 'error',
                message: `审核失败: ${error.message}`
            });
        }
    }

    private async _callAI(apiUrl: string, apiKey: string, model: string, diff: string): Promise<string> {
        // 定义 API 响应类型
        interface AIResponse {
            choices?: Array<{
                message?: {
                    content: string;
                };
                text?: string;
            }>;
        }

        const prompt = `请作为资深代码审查员，对以下 Git diff 进行详细审查。请从以下几个方面分析：
1. 代码质量和规范性
2. 潜在的错误或漏洞
3. 性能问题
4. 安全性和最佳实践
5. 改进建议

Git Diff:
\`\`\`diff
${diff}
\`\`\`

请以结构化的方式给出审查意见，使用 Markdown 格式。`;

        // 支持 OpenAI 格式和通用格式
        const isOpenAIFormat = apiUrl.includes('openai.com') || apiUrl.includes('api.openai');
        
        const body = isOpenAIFormat ? {
            model: model,
            messages: [
                { role: 'system', content: '你是一个专业的代码审查助手。' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 4000
        } : {
            model: model,
            prompt: prompt,
            max_tokens: 4000,
            temperature: 0.7
        };

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
        }

        const data = await response.json() as AIResponse;
        
        // 解析不同格式的响应
        if (data.choices && data.choices[0]) {
            if (data.choices[0].message) {
                return data.choices[0].message.content;
            } else if (data.choices[0].text) {
                return data.choices[0].text;
            }
        }
        
        return JSON.stringify(data, null, 2);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // 将 HTML 作为数组拼接，避免模板字符串嵌套问题
        const htmlParts = [
            `<!DOCTYPE html>`,
            `<html lang="zh-CN">`,
            `<head>`,
            `    <meta charset="UTF-8">`,
            `    <meta name="viewport" content="width=device-width, initial-scale=1.0">`,
            `    <title>AI Commit Reviewer</title>`,
            `    <style>`,
            `        * { box-sizing: border-box; margin: 0; padding: 0; }`,
            `        body {`,
            `            font-family: var(--vscode-font-family);`,
            `            font-size: var(--vscode-font-size);`,
            `            color: var(--vscode-foreground);`,
            `            background-color: var(--vscode-sidebar-background);`,
            `            padding: 16px;`,
            `            line-height: 1.6;`,
            `        }`,
            `        .section {`,
            `            margin-bottom: 20px;`,
            `            background: var(--vscode-editor-background);`,
            `            border-radius: 8px;`,
            `            padding: 16px;`,
            `            border: 1px solid var(--vscode-panel-border);`,
            `        }`,
            `        .section-title {`,
            `            font-size: 14px;`,
            `            font-weight: 600;`,
            `            margin-bottom: 12px;`,
            `            color: var(--vscode-foreground);`,
            `            display: flex;`,
            `            align-items: center;`,
            `            gap: 6px;`,
            `        }`,
            `        .form-group { margin-bottom: 12px; }`,
            `        label {`,
            `            display: block;`,
            `            margin-bottom: 6px;`,
            `            font-size: 12px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `            font-weight: 500;`,
            `        }`,
            `        input[type="text"],`,
            `        input[type="password"],`,
            `        select {`,
            `            width: 100%;`,
            `            padding: 8px 10px;`,
            `            border: 1px solid var(--vscode-input-border);`,
            `            background: var(--vscode-input-background);`,
            `            color: var(--vscode-input-foreground);`,
            `            border-radius: 4px;`,
            `            font-size: 13px;`,
            `            outline: none;`,
            `            transition: border-color 0.2s;`,
            `        }`,
            `        input:focus, select:focus { border-color: var(--vscode-focusBorder); }`,
            `        .btn {`,
            `            width: 100%;`,
            `            padding: 10px;`,
            `            border: none;`,
            `            border-radius: 4px;`,
            `            font-size: 13px;`,
            `            font-weight: 600;`,
            `            cursor: pointer;`,
            `            transition: all 0.2s;`,
            `            display: flex;`,
            `            align-items: center;`,
            `            justify-content: center;`,
            `            gap: 6px;`,
            `        }`,
            `        .btn-primary {`,
            `            background: var(--vscode-button-background);`,
            `            color: var(--vscode-button-foreground);`,
            `        }`,
            `        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }`,
            `        .btn-secondary {`,
            `            background: var(--vscode-button-secondaryBackground);`,
            `            color: var(--vscode-button-secondaryForeground);`,
            `            margin-top: 8px;`,
            `        }`,
            `        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }`,
            `        .result-container { display: none; margin-top: 16px; }`,
            `        .result-container.active { display: block; }`,
            `        .loading {`,
            `            display: none;`,
            `            text-align: center;`,
            `            padding: 20px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `        }`,
            `        .loading.active { display: block; }`,
            `        .spinner {`,
            `            display: inline-block;`,
            `            width: 20px;`,
            `            height: 20px;`,
            `            border: 2px solid var(--vscode-button-background);`,
            `            border-top-color: transparent;`,
            `            border-radius: 50%;`,
            `            animation: spin 1s linear infinite;`,
            `            margin-right: 8px;`,
            `        }`,
            `        @keyframes spin { to { transform: rotate(360deg); } }`,
            `        .error {`,
            `            display: none;`,
            `            background: var(--vscode-inputValidation-errorBackground);`,
            `            border: 1px solid var(--vscode-inputValidation-errorBorder);`,
            `            color: var(--vscode-inputValidation-errorForeground);`,
            `            padding: 10px;`,
            `            border-radius: 4px;`,
            `            margin-top: 12px;`,
            `            font-size: 12px;`,
            `        }`,
            `        .error.active { display: block; }`,
            `        .review-result {`,
            `            background: var(--vscode-textBlockQuote-background);`,
            `            border-left: 3px solid var(--vscode-textBlockQuote-border);`,
            `            padding: 12px;`,
            `            border-radius: 0 4px 4px 0;`,
            `            font-size: 13px;`,
            `            line-height: 1.8;`,
            `            overflow-x: auto;`,
            `        }`,
            `        .review-result h1, .review-result h2, .review-result h3 {`,
            `            margin-top: 16px;`,
            `            margin-bottom: 8px;`,
            `            color: var(--vscode-foreground);`,
            `        }`,
            `        .review-result code {`,
            `            background: var(--vscode-textCodeBlock-background);`,
            `            padding: 2px 6px;`,
            `            border-radius: 3px;`,
            `            font-family: var(--vscode-editor-font-family);`,
            `            font-size: 12px;`,
            `        }`,
            `        .review-result pre {`,
            `            background: var(--vscode-textCodeBlock-background);`,
            `            padding: 12px;`,
            `            border-radius: 4px;`,
            `            overflow-x: auto;`,
            `            margin: 8px 0;`,
            `        }`,
            `        .commit-info {`,
            `            background: var(--vscode-badge-background);`,
            `            color: var(--vscode-badge-foreground);`,
            `            padding: 4px 8px;`,
            `            border-radius: 4px;`,
            `            font-size: 11px;`,
            `            font-family: monospace;`,
            `            margin-bottom: 12px;`,
            `            display: inline-block;`,
            `        }`,
            `        .diff-preview {`,
            `            background: var(--vscode-textCodeBlock-background);`,
            `            padding: 12px;`,
            `            border-radius: 4px;`,
            `            font-family: var(--vscode-editor-font-family);`,
            `            font-size: 11px;`,
            `            max-height: 200px;`,
            `            overflow-y: auto;`,
            `            margin-bottom: 16px;`,
            `            white-space: pre-wrap;`,
            `            word-break: break-all;`,
            `            color: var(--vscode-descriptionForeground);`,
            `        }`,
            `        .diff-preview::-webkit-scrollbar { width: 8px; height: 8px; }`,
            `        .diff-preview::-webkit-scrollbar-thumb {`,
            `            background: var(--vscode-scrollbarSlider-background);`,
            `            border-radius: 4px;`,
            `        }`,
            `        .status-bar {`,
            `            display: flex;`,
            `            justify-content: space-between;`,
            `            align-items: center;`,
            `            margin-top: 8px;`,
            `            font-size: 11px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `        }`,
            `        .icon {`,
            `            width: 16px;`,
            `            height: 16px;`,
            `            display: inline-flex;`,
            `            align-items: center;`,
            `            justify-content: center;`,
            `        }`,
            `    </style>`,
            `</head>`,
            `<body>`,
            `    <div class="section">`,
            `        <div class="section-title">`,
            `            <span class="icon">⚙️</span>`,
            `            API 配置`,
            `        </div>`,
            `        `,
            `        <div class="form-group">`,
            `            <label>API 地址</label>`,
            `            <input type="text" id="apiUrl" placeholder="https://api.openai.com/v1/chat/completions">`,
            `        </div>`,
            `        `,
            `        <div class="form-group">`,
            `            <label>API Key</label>`,
            `            <input type="password" id="apiKey" placeholder="sk-...">`,
            `        </div>`,
            `        `,
            `        <div class="form-group">`,
            `            <label>模型</label>`,
            `            <select id="model">`,
            `                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>`,
            `                <option value="gpt-4">GPT-4</option>`,
            `                <option value="gpt-4-turbo">GPT-4 Turbo</option>`,
            `                <option value="claude-3-opus-20240229">Claude 3 Opus</option>`,
            `                <option value="claude-3-sonnet-20240229">Claude 3 Sonnet</option>`,
            `                <option value="custom">自定义</option>`,
            `            </select>`,
            `        </div>`,
            ``,
            `        <button class="btn btn-secondary" id="saveBtn">`,
            `            <span>💾</span> 保存配置`,
            `        </button>`,
            `    </div>`,
            ``,
            `    <div class="section">`,
            `        <div class="section-title">`,
            `            <span class="icon">🔍</span>`,
            `            代码审核`,
            `        </div>`,
            `        `,
            `        <button class="btn btn-primary" id="reviewBtn">`,
            `            <span>🚀</span> 审核最新 Commit`,
            `        </button>`,
            ``,
            `        <div class="loading" id="loading">`,
            `            <div class="spinner"></div>`,
            `            <div id="loadingText">正在处理...</div>`,
            `        </div>`,
            ``,
            `        <div class="error" id="error"></div>`,
            ``,
            `        <div class="result-container" id="result">`,
            `            <div class="commit-info" id="commitHash"></div>`,
            `            <div class="diff-preview" id="diffPreview"></div>`,
            `            <div class="review-result" id="reviewContent"></div>`,
            `        </div>`,
            `    </div>`,
            ``,
            `    <script>`,
            `        const vscode = acquireVsCodeApi();`,
            `        `,
            `        // 元素引用`,
            `        const apiUrlInput = document.getElementById('apiUrl');`,
            `        const apiKeyInput = document.getElementById('apiKey');`,
            `        const modelSelect = document.getElementById('model');`,
            `        const saveBtn = document.getElementById('saveBtn');`,
            `        const reviewBtn = document.getElementById('reviewBtn');`,
            `        const loading = document.getElementById('loading');`,
            `        const loadingText = document.getElementById('loadingText');`,
            `        const error = document.getElementById('error');`,
            `        const result = document.getElementById('result');`,
            `        const commitHash = document.getElementById('commitHash');`,
            `        const diffPreview = document.getElementById('diffPreview');`,
            `        const reviewContent = document.getElementById('reviewContent');`,
            ``,
            `        // 初始化时获取配置`,
            `        vscode.postMessage({ type: 'getConfig' });`,
            ``,
            `        // 保存配置`,
            `        saveBtn.addEventListener('click', () => {`,
            `            const customModel = modelSelect.value === 'custom' `,
            `                ? prompt('请输入自定义模型名称:', 'gpt-3.5-turbo') `,
            `                : modelSelect.value;`,
            `                `,
            `            vscode.postMessage({`,
            `                type: 'saveConfig',`,
            `                apiUrl: apiUrlInput.value,`,
            `                apiKey: apiKeyInput.value,`,
            `                model: customModel || modelSelect.value`,
            `            });`,
            `        });`,
            ``,
            `        // 开始审核`,
            `        reviewBtn.addEventListener('click', () => {`,
            `            vscode.postMessage({ type: 'review' });`,
            `        });`,
            ``,
            `        // 处理来自扩展的消息`,
            `        window.addEventListener('message', event => {`,
            `            const message = event.data;`,
            `            `,
            `            switch (message.type) {`,
            `                case 'config':`,
            `                    apiUrlInput.value = message.apiUrl;`,
            `                    if (message.apiKey) {`,
            `                        apiKeyInput.value = message.apiKey;`,
            `                        apiKeyInput.placeholder = '已配置 (点击修改)';`,
            `                    }`,
            `                    // 设置模型选择`,
            `                    if (message.model && [...modelSelect.options].some(o => o.value === message.model)) {`,
            `                        modelSelect.value = message.model;`,
            `                    } else if (message.model) {`,
            `                        // 自定义模型`,
            `                        const customOption = document.createElement('option');`,
            `                        customOption.value = message.model;`,
            `                        customOption.text = message.model;`,
            `                        modelSelect.add(customOption);`,
            `                        modelSelect.value = message.model;`,
            `                    }`,
            `                    break;`,
            `                    `,
            `                case 'loading':`,
            `                    loading.classList.add('active');`,
            `                    error.classList.remove('active');`,
            `                    result.classList.remove('active');`,
            `                    loadingText.textContent = message.message;`,
            `                    reviewBtn.disabled = true;`,
            `                    break;`,
            `                    `,
            `                case 'error':`,
            `                    loading.classList.remove('active');`,
            `                    error.classList.add('active');`,
            `                    error.textContent = message.message;`,
            `                    reviewBtn.disabled = false;`,
            `                    break;`,
            `                    `,
            `                case 'reviewResult':`,
            `                    loading.classList.remove('active');`,
            `                    result.classList.add('active');`,
            `                    commitHash.textContent = 'Commit: ' + message.commitHash;`,
            `                    diffPreview.textContent = message.diff;`,
            `                    reviewContent.innerHTML = markdownToHtml(message.result);`,
            `                    reviewBtn.disabled = false;`,
            `                    break;`,
            `                    `,
            `                case 'clear':`,
            `                    result.classList.remove('active');`,
            `                    error.classList.remove('active');`,
            `                    break;`,
            `            }`,
            `        });`,
            ``,
            `        // 简单的 Markdown 转 HTML`,
            `        function markdownToHtml(markdown) {`,
            `            return markdown`,
            `                .replace(/^### (.*$)/gim, '<h3>$1</h3>')`,
            `                .replace(/^## (.*$)/gim, '<h2>$1</h2>')`,
            `                .replace(/^# (.*$)/gim, '<h1>$1</h1>')`,
            `                .replace(/\\*\\*\\*(.*?)\\*\\*\\*/gim, '<strong><em>$1</em></strong>')`,
            `                .replace(/\\*\\*(.*?)\\*\\*/gim, '<strong>$1</strong>')`,
            `                .replace(/\\*(.*?)\\*/gim, '<em>$1</em>')`,
            `                .replace(/~~(.*?)~~/gim, '<del>$1</del>')`,
            `                .replace(/\`\`\`([\\s\\S]*?)\`\`\`/gim, '<pre><code>$1</code></pre>')`,
            `                .replace(/\\` + "`" + `([^\\` + "`" + `]+)\\` + "`" + `/gim, '<code>$1</code>')`,
            `                .replace(/^\\> (.*$)/gim, '<blockquote>$1</blockquote>')`,
            `                .replace(/^\\- (.*$)/gim, '<ul><li>$1</li></ul>')`,
            `                .replace(/^\\d+\\. (.*$)/gim, '<ol><li>$1</li></ol>')`,
            `                .replace(/\\n/gim, '<br>');`,
            `        }`,
            `    </script>`,
            `</body>`,
            `</html>`
        ];
        
        return htmlParts.join('\n');
    }
}