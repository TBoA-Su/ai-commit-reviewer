import * as vscode from 'vscode';
import { getGitDiff, getLastCommitHash } from './git';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _context: vscode.ExtensionContext;
    private _currentDiff: string = '';
    private _currentCommitHash: string = '';

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

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'saveConfig':
                    await this._saveConfig(data.apiUrl, data.apiKey, data.model);
                    break;
                case 'getDiff':
                    await this._getGitDiff();
                    break;
                case 'review':
                    await this._performReview();
                    break;
                case 'getConfig':
                    await this._sendConfigToWebview();
                    break;
                case 'navigate':
                    break;
            }
        });

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
            apiKey: apiKey ? '••••••••' : '',
            model
        });
    }

    private async _saveConfig(apiUrl: string, apiKey: string, model: string) {
        const config = vscode.workspace.getConfiguration('aiCommitReviewer');
        
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
        await this._getGitDiff();
    }

    public refresh() {
        this._view?.webview.postMessage({ type: 'clear' });
        this._sendConfigToWebview();
    }

    private async _getGitDiff() {
        if (!this._view) return;

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            this._view.webview.postMessage({
                type: 'error',
                message: '请打开一个工作区'
            });
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;

        try {
            this._view.webview.postMessage({ type: 'loading', message: '正在获取代码变更...' });

            const diff = await getGitDiff(rootPath);
            
            if (!diff || diff.trim() === '') {
                this._view.webview.postMessage({
                    type: 'error',
                    message: '没有检测到代码变更。可能的原因：\n1. 当前没有 staged changes\n2. 最近 commit 是空提交\n3. 这是仓库的第一个提交\n\n提示：如果要审核已提交的代码，请确保有 parent commit（即至少有两个提交）'
                });
                return;
            }

            const commitHash = await getLastCommitHash(rootPath);
            this._currentCommitHash = commitHash ? commitHash.substring(0, 7) : 'working tree';
            this._currentDiff = diff;

            this._view.webview.postMessage({
                type: 'diffPreview',
                commitHash: this._currentCommitHash,
                diff: diff,
                stats: this._analyzeDiff(diff)
            });

        } catch (error: any) {
            this._view.webview.postMessage({
                type: 'error',
                message: `获取失败: ${error.message}`
            });
        }
    }

    private _analyzeDiff(diff: string): { files: number; additions: number; deletions: number } {
        const lines = diff.split('\n');
        let files = 0;
        let additions = 0;
        let deletions = 0;

        for (const line of lines) {
            if (line.startsWith('diff --git')) {
                files++;
            } else if (line.startsWith('+') && !line.startsWith('+++')) {
                additions++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletions++;
            }
        }

        return { files, additions, deletions };
    }

    private async _performReview() {
        if (!this._view) return;

        const config = vscode.workspace.getConfiguration('aiCommitReviewer');
        const apiUrl = config.get<string>('apiUrl');
        const apiKey = config.get<string>('apiKey');
        const model = config.get<string>('model') || 'gpt-3.5-turbo';

        if (!apiUrl || !apiKey) {
            this._view.webview.postMessage({
                type: 'error',
                message: '请先配置 API 地址和 Key（切换到设置页面）'
            });
            return;
        }

        if (!this._currentDiff) {
            this._view.webview.postMessage({
                type: 'error',
                message: '请先获取代码变更'
            });
            return;
        }

        try {
            this._view.webview.postMessage({ 
                type: 'reviewing', 
                message: `正在将代码发送给 ${model} 进行质量评估...` 
            });

            const reviewResult = await this._callAI(apiUrl, apiKey, model, this._currentDiff);

            this._view.webview.postMessage({
                type: 'reviewResult',
                commitHash: this._currentCommitHash,
                result: reviewResult
            });

        } catch (error: any) {
            this._view.webview.postMessage({
                type: 'error',
                message: `AI 审核失败: ${error.message}`
            });
        }
    }

    private async _callAI(apiUrl: string, apiKey: string, model: string, diff: string): Promise<string> {
        interface AIResponse {
            choices?: Array<{
                message?: { content: string };
                text?: string;
            }>;
        }

        const prompt = `请作为资深代码审查专家，对以下 Git diff 中的代码更改进行全面的质量评估。

## 审查要求
请从以下几个维度进行详细分析：

1. **代码质量**
   - 代码可读性和可维护性
   - 是否符合编程规范（命名、格式、结构）
   - 是否有重复代码或可以重构的部分

2. **潜在问题**
   - 是否存在逻辑错误
   - 是否有空指针、数组越界等常见错误
   - 异常处理是否完善

3. **性能影响**
   - 是否有性能瓶颈
   - 算法复杂度是否合理
   - 是否有不必要的资源消耗

4. **安全性**
   - 是否存在安全漏洞
   - 敏感信息是否被正确处理
   - 输入验证是否充分

5. **改进建议**
   - 具体的优化建议
   - 更好的实现方式
   - 需要注意的最佳实践

## Git Diff 内容
\`\`\`diff
${diff}
\`\`\`

请以结构化的 Markdown 格式输出审查结果，使用中文。对于发现的问题，请标注严重程度（严重/警告/建议）。`;

        const isOpenAIFormat = apiUrl.includes('openai.com') || apiUrl.includes('api.openai');
        
        const body = isOpenAIFormat ? {
            model: model,
            messages: [
                { role: 'system', content: '你是一位专业的代码审查专家，擅长发现代码中的问题并提供建设性的改进建议。' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 4000
        } : {
            model: model,
            prompt: prompt,
            max_tokens: 4000,
            temperature: 0.3
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
            `            line-height: 1.6;`,
            `        }`,
            `        `,
            `        .navbar {`,
            `            display: flex;`,
            `            background: var(--vscode-editor-background);`,
            `            border-bottom: 1px solid var(--vscode-panel-border);`,
            `            padding: 0 8px;`,
            `            position: sticky;`,
            `            top: 0;`,
            `            z-index: 100;`,
            `        }`,
            `        .nav-tab {`,
            `            flex: 1;`,
            `            padding: 12px 8px;`,
            `            text-align: center;`,
            `            cursor: pointer;`,
            `            border: none;`,
            `            background: transparent;`,
            `            color: var(--vscode-foreground);`,
            `            font-size: 13px;`,
            `            font-weight: 500;`,
            `            border-bottom: 2px solid transparent;`,
            `            transition: all 0.2s;`,
            `            display: flex;`,
            `            align-items: center;`,
            `            justify-content: center;`,
            `            gap: 6px;`,
            `        }`,
            `        .nav-tab:hover {`,
            `            background: var(--vscode-list-hoverBackground);`,
            `        }`,
            `        .nav-tab.active {`,
            `            border-bottom-color: var(--vscode-button-background);`,
            `            color: var(--vscode-button-background);`,
            `        }`,
            `        `,
            `        .page {`,
            `            display: none;`,
            `            padding: 16px;`,
            `        }`,
            `        .page.active {`,
            `            display: block;`,
            `        }`,
            `        `,
            `        .section {`,
            `            margin-bottom: 16px;`,
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
            `            justify-content: space-between;`,
            `            gap: 6px;`,
            `        }`,
            `        .section-title-left {`,
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
            `        input[type="password"] {`,
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
            `        input:focus { border-color: var(--vscode-focusBorder); }`,
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
            `        .btn-success {`,
            `            background: var(--vscode-testing-iconPassed);`,
            `            color: white;`,
            `        }`,
            `        .btn:disabled {`,
            `            opacity: 0.6;`,
            `            cursor: not-allowed;`,
            `        }`,
            `        .diff-container {`,
            `            background: var(--vscode-textCodeBlock-background);`,
            `            border-radius: 6px;`,
            `            overflow: hidden;`,
            `            margin-top: 12px;`,
            `        }`,
            `        .diff-header {`,
            `            background: var(--vscode-titleBar-activeBackground);`,
            `            padding: 8px 12px;`,
            `            font-size: 11px;`,
            `            font-family: monospace;`,
            `            border-bottom: 1px solid var(--vscode-panel-border);`,
            `            display: flex;`,
            `            justify-content: space-between;`,
            `            align-items: center;`,
            `        }`,
            `        .diff-stats {`,
            `            display: flex;`,
            `            gap: 12px;`,
            `            font-size: 11px;`,
            `        }`,
            `        .stat-additions { color: var(--vscode-gitDecoration-addedResourceForeground); }`,
            `        .stat-deletions { color: var(--vscode-gitDecoration-deletedResourceForeground); }`,
            `        .diff-content {`,
            `            padding: 12px;`,
            `            font-family: var(--vscode-editor-font-family);`,
            `            font-size: 12px;`,
            `            max-height: 300px;`,
            `            overflow-y: auto;`,
            `            white-space: pre-wrap;`,
            `            word-break: break-all;`,
            `            line-height: 1.5;`,
            `        }`,
            `        .diff-line {`,
            `            padding: 1px 4px;`,
            `            margin: 0 -12px;`,
            `            padding-left: 12px;`,
            `        }`,
            `        .diff-addition {`,
            `            background: var(--vscode-diffEditor-insertedLineBackground);`,
            `            color: var(--vscode-gitDecoration-addedResourceForeground);`,
            `        }`,
            `        .diff-deletion {`,
            `            background: var(--vscode-diffEditor-removedLineBackground);`,
            `            color: var(--vscode-gitDecoration-deletedResourceForeground);`,
            `        }`,
            `        .diff-meta {`,
            `            color: var(--vscode-descriptionForeground);`,
            `            font-weight: 600;`,
            `        }`,
            `        .loading {`,
            `            display: none;`,
            `            text-align: center;`,
            `            padding: 40px 20px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `        }`,
            `        .loading.active { display: block; }`,
            `        .spinner {`,
            `            display: inline-block;`,
            `            width: 32px;`,
            `            height: 32px;`,
            `            border: 3px solid var(--vscode-button-background);`,
            `            border-top-color: transparent;`,
            `            border-radius: 50%;`,
            `            animation: spin 1s linear infinite;`,
            `            margin-bottom: 12px;`,
            `        }`,
            `        @keyframes spin { to { transform: rotate(360deg); } }`,
            `        .error {`,
            `            display: none;`,
            `            background: var(--vscode-inputValidation-errorBackground);`,
            `            border: 1px solid var(--vscode-inputValidation-errorBorder);`,
            `            color: var(--vscode-inputValidation-errorForeground);`,
            `            padding: 12px;`,
            `            border-radius: 4px;`,
            `            margin-top: 12px;`,
            `            font-size: 12px;`,
            `        }`,
            `        .error.active { display: block; }`,
            `        .review-result {`,
            `            background: var(--vscode-textBlockQuote-background);`,
            `            border-left: 3px solid var(--vscode-textBlockQuote-border);`,
            `            padding: 16px;`,
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
            `        .review-result h1 { font-size: 16px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 8px; }`,
            `        .review-result h2 { font-size: 14px; color: var(--vscode-button-background); }`,
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
            `        .commit-badge {`,
            `            background: var(--vscode-badge-background);`,
            `            color: var(--vscode-badge-foreground);`,
            `            padding: 4px 8px;`,
            `            border-radius: 4px;`,
            `            font-size: 11px;`,
            `            font-family: monospace;`,
            `        }`,
            `        .hint {`,
            `            font-size: 11px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `            margin-top: 4px;`,
            `        }`,
            `        .step-indicator {`,
            `            display: flex;`,
            `            align-items: center;`,
            `            gap: 8px;`,
            `            margin-bottom: 16px;`,
            `            padding: 12px;`,
            `            background: var(--vscode-editor-background);`,
            `            border-radius: 6px;`,
            `            border: 1px solid var(--vscode-panel-border);`,
            `        }`,
            `        .step {`,
            `            display: flex;`,
            `            align-items: center;`,
            `            gap: 6px;`,
            `            font-size: 12px;`,
            `            color: var(--vscode-descriptionForeground);`,
            `        }`,
            `        .step.active {`,
            `            color: var(--vscode-button-background);`,
            `            font-weight: 600;`,
            `        }`,
            `        .step-number {`,
            `            width: 20px;`,
            `            height: 20px;`,
            `            border-radius: 50%;`,
            `            background: var(--vscode-badge-background);`,
            `            color: var(--vscode-badge-foreground);`,
            `            display: flex;`,
            `            align-items: center;`,
            `            justify-content: center;`,
            `            font-size: 11px;`,
            `            font-weight: 700;`,
            `        }`,
            `        .step.active .step-number {`,
            `            background: var(--vscode-button-background);`,
            `            color: var(--vscode-button-foreground);`,
            `        }`,
            `        .step-divider {`,
            `            flex: 1;`,
            `            height: 1px;`,
            `            background: var(--vscode-panel-border);`,
            `            max-width: 30px;`,
            `        }`,
            `        .hidden { display: none !important; }`,
            `    </style>`,
            `</head>`,
            `<body>`,
            `    <div class="navbar">`,
            `        <button class="nav-tab active" data-page="review">`,
            `            <span>🔍</span> 代码审核`,
            `        </button>`,
            `        <button class="nav-tab" data-page="settings">`,
            `            <span>⚙️</span> 设置`,
            `        </button>`,
            `    </div>`,
            ``,
            `    <div id="reviewPage" class="page active">`,
            `        <div class="step-indicator">`,
            `            <div class="step active" id="step1">`,
            `                <div class="step-number">1</div>`,
            `                <span>获取 Diff</span>`,
            `            </div>`,
            `            <div class="step-divider"></div>`,
            `            <div class="step" id="step2">`,
            `                <div class="step-number">2</div>`,
            `                <span>AI 评估</span>`,
            `            </div>`,
            `        </div>`,
            ``,
            `        <div id="diffSection">`,
            `            <div class="section">`,
            `                <div class="section-title">`,
            `                    <div class="section-title-left">`,
            `                        <span>📋</span>`,
            `                        <span>获取 Git 变更</span>`,
            `                    </div>`,
            `                </div>`,
            `                <p style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">`,
            `                    点击按钮获取当前代码变更（staged changes 或最近 commit）`,
            `                </p>`,
            `                <button class="btn btn-primary" id="getDiffBtn">`,
            `                    <span>📥</span> 获取代码变更`,
            `                </button>`,
            `            </div>`,
            `        </div>`,
            ``,
            `        <div id="diffPreviewSection" class="hidden">`,
            `            <div class="section">`,
            `                <div class="section-title">`,
            `                    <div class="section-title-left">`,
            `                        <span>📝</span>`,
            `                        <span>代码变更预览</span>`,
            `                    </div>`,
            `                    <span class="commit-badge" id="commitBadge"></span>`,
            `                </div>`,
            `                <div class="diff-container">`,
            `                    <div class="diff-header">`,
            `                        <span>变更统计</span>`,
            `                        <div class="diff-stats">`,
            `                            <span id="statFiles"></span>`,
            `                            <span class="stat-additions" id="statAdditions"></span>`,
            `                            <span class="stat-deletions" id="statDeletions"></span>`,
            `                        </div>`,
            `                    </div>`,
            `                    <div class="diff-content" id="diffContent"></div>`,
            `                </div>`,
            `                <div style="margin-top: 12px; display: flex; gap: 8px;">`,
            `                    <button class="btn btn-success" id="reviewBtn" style="flex: 1;">`,
            `                        <span>🤖</span> 发送给 AI 评估`,
            `                    </button>`,
            `                    <button class="btn btn-secondary" id="refreshDiffBtn" style="flex: 0 0 auto; width: auto; padding: 10px 16px; margin-top: 0;">`,
            `                        <span>🔄</span>`,
            `                    </button>`,
            `                </div>`,
            `            </div>`,
            `        </div>`,
            ``,
            `        <div class="loading" id="loading">`,
            `            <div class="spinner"></div>`,
            `            <div id="loadingText">正在处理...</div>`,
            `        </div>`,
            ``,
            `        <div class="error" id="error"></div>`,
            ``,
            `        <div id="reviewResultSection" class="hidden">`,
            `            <div class="section">`,
            `                <div class="section-title">`,
            `                    <div class="section-title-left">`,
            `                        <span>✅</span>`,
            `                        <span>AI 代码质量评估</span>`,
            `                    </div>`,
            `                    <span class="commit-badge" id="resultCommitBadge"></span>`,
            `                </div>`,
            `                <div class="review-result" id="reviewContent"></div>`,
            `                <button class="btn btn-secondary" id="newReviewBtn" style="margin-top: 12px;">`,
            `                    <span>🔄</span> 开始新的审核`,
            `                </button>`,
            `            </div>`,
            `        </div>`,
            `    </div>`,
            ``,
            `    <div id="settingsPage" class="page">`,
            `        <div class="section">`,
            `            <div class="section-title">`,
            `                <span>🔑</span> API 配置`,
            `            </div>`,
            `            `,
            `            <div class="form-group">`,
            `                <label>API 地址</label>`,
            `                <input type="text" id="apiUrl" placeholder="https://api.openai.com/v1/chat/completions">`,
            `                <div class="hint">支持 OpenAI、Azure、Claude、本地模型等兼容 API</div>`,
            `            </div>`,
            `            `,
            `            <div class="form-group">`,
            `                <label>API Key</label>`,
            `                <input type="password" id="apiKey" placeholder="sk-...">`,
            `                <div class="hint">您的 API 密钥将被安全存储在 VS Code 配置中</div>`,
            `            </div>`,
            `            `,
            `            <div class="form-group">`,
            `                <label>模型名称</label>`,
            `                <input type="text" id="model" list="modelList" placeholder="输入模型名称，如 gpt-4、claude-3-opus...">`,
            `                <datalist id="modelList">`,
            `                    <option value="gpt-3.5-turbo">`,
            `                    <option value="gpt-4">`,
            `                    <option value="gpt-4-turbo">`,
            `                    <option value="gpt-4o">`,
            `                    <option value="gpt-4o-mini">`,
            `                    <option value="claude-3-opus-20240229">`,
            `                    <option value="claude-3-sonnet-20240229">`,
            `                    <option value="claude-3-haiku-20240307">`,
            `                    <option value="claude-3-5-sonnet-20241022">`,
            `                    <option value="llama3-8b">`,
            `                    <option value="llama3-70b">`,
            `                    <option value="qwen-turbo">`,
            `                    <option value="qwen-max">`,
            `                    <option value="deepseek-chat">`,
            `                    <option value="deepseek-coder">`,
            `                </datalist>`,
            `                <div class="hint">支持任意模型：OpenAI、Claude、Llama、通义千问、DeepSeek 等</div>`,
            `            </div>`,
            ``,
            `            <button class="btn btn-primary" id="saveBtn">`,
            `                <span>💾</span> 保存配置`,
            `            </button>`,
            `        </div>`,
            ``,
            `        <div class="section">`,
            `            <div class="section-title">`,
            `                <span>ℹ️</span> 使用说明`,
            `            </div>`,
            `            <div style="font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.8;">`,
            `                <p><strong>1.</strong> 在设置页面配置您的 AI API 信息</p>`,
            `                <p><strong>2.</strong> 返回代码审核页面，点击"获取代码变更"</p>`,
            `                <p><strong>3.</strong> 预览 diff 确认无误后，点击"发送给 AI 评估"</p>`,
            `                <p><strong>4.</strong> 查看 AI 的代码质量分析报告</p>`,
            `            </div>`,
            `        </div>`,
            `    </div>`,
            ``,
            `    <script>`,
            `        const vscode = acquireVsCodeApi();`,
            `        `,
            `        const navTabs = document.querySelectorAll('.nav-tab');`,
            `        const pages = document.querySelectorAll('.page');`,
            `        `,
            `        const diffSection = document.getElementById('diffSection');`,
            `        const diffPreviewSection = document.getElementById('diffPreviewSection');`,
            `        const reviewResultSection = document.getElementById('reviewResultSection');`,
            `        const loading = document.getElementById('loading');`,
            `        const loadingText = document.getElementById('loadingText');`,
            `        const error = document.getElementById('error');`,
            `        `,
            `        const getDiffBtn = document.getElementById('getDiffBtn');`,
            `        const reviewBtn = document.getElementById('reviewBtn');`,
            `        const refreshDiffBtn = document.getElementById('refreshDiffBtn');`,
            `        const newReviewBtn = document.getElementById('newReviewBtn');`,
            `        `,
            `        const commitBadge = document.getElementById('commitBadge');`,
            `        const statFiles = document.getElementById('statFiles');`,
            `        const statAdditions = document.getElementById('statAdditions');`,
            `        const statDeletions = document.getElementById('statDeletions');`,
            `        const diffContent = document.getElementById('diffContent');`,
            `        const resultCommitBadge = document.getElementById('resultCommitBadge');`,
            `        const reviewContent = document.getElementById('reviewContent');`,
            `        `,
            `        const step1 = document.getElementById('step1');`,
            `        const step2 = document.getElementById('step2');`,
            `        `,
            `        const apiUrlInput = document.getElementById('apiUrl');`,
            `        const apiKeyInput = document.getElementById('apiKey');`,
            `        const saveBtn = document.getElementById('saveBtn');`,
            ``,
            `        navTabs.forEach(tab => {`,
            `            tab.addEventListener('click', () => {`,
            `                const targetPage = tab.dataset.page;`,
            `                navTabs.forEach(t => t.classList.remove('active'));`,
            `                tab.classList.add('active');`,
            `                pages.forEach(page => page.classList.remove('active'));`,
            `                document.getElementById(targetPage + 'Page').classList.add('active');`,
            `            });`,
            `        });`,
            ``,
            `        vscode.postMessage({ type: 'getConfig' });`,
            ``,
            `        getDiffBtn.addEventListener('click', () => {`,
            `            vscode.postMessage({ type: 'getDiff' });`,
            `        });`,
            ``,
            `        refreshDiffBtn.addEventListener('click', () => {`,
            `            resetToStep1();`,
            `            vscode.postMessage({ type: 'getDiff' });`,
            `        });`,
            ``,
            `        reviewBtn.addEventListener('click', () => {`,
            `            vscode.postMessage({ type: 'review' });`,
            `        });`,
            ``,
            `        newReviewBtn.addEventListener('click', () => {`,
            `            resetToStep1();`,
            `        });`,
            ``,
            `        saveBtn.addEventListener('click', () => {`,
            `            const modelValue = document.getElementById('model').value.trim();`,
            `            `,
            `            vscode.postMessage({`,
            `                type: 'saveConfig',`,
            `                apiUrl: apiUrlInput.value,`,
            `                apiKey: apiKeyInput.value,`,
            `                model: modelValue || 'gpt-3.5-turbo'`,
            `            });`,
            `        });`,
            ``,
            `        function resetToStep1() {`,
            `            diffSection.classList.remove('hidden');`,
            `            diffPreviewSection.classList.add('hidden');`,
            `            reviewResultSection.classList.add('hidden');`,
            `            error.classList.remove('active');`,
            `            step1.classList.add('active');`,
            `            step2.classList.remove('active');`,
            `        }`,
            ``,
            `        window.addEventListener('message', event => {`,
            `            const msg = event.data;`,
            `            `,
            `            switch (msg.type) {`,
            `                case 'config':`,
            `                    if (msg.apiUrl) apiUrlInput.value = msg.apiUrl;`,
            `                    if (msg.apiKey) {`,
            `                        apiKeyInput.value = msg.apiKey;`,
            `                        apiKeyInput.placeholder = '已配置 (点击修改)';`,
            `                    }`,
            `                    if (msg.model) {`,
            `                        document.getElementById('model').value = msg.model;`,
            `                    }`,
            `                    break;`,
            `                    `,
            `                case 'loading':`,
            `                    loading.classList.add('active');`,
            `                    error.classList.remove('active');`,
            `                    loadingText.textContent = msg.message;`,
            `                    getDiffBtn.disabled = true;`,
            `                    break;`,
            `                    `,
            `                case 'diffPreview':`,
            `                    loading.classList.remove('active');`,
            `                    error.classList.remove('active');`,
            `                    getDiffBtn.disabled = false;`,
            `                    `,
            `                    diffSection.classList.add('hidden');`,
            `                    diffPreviewSection.classList.remove('hidden');`,
            `                    reviewResultSection.classList.add('hidden');`,
            `                    `,
            `                    step1.classList.add('active');`,
            `                    step2.classList.remove('active');`,
            `                    `,
            `                    commitBadge.textContent = msg.commitHash;`,
            `                    statFiles.textContent = msg.stats.files + ' 个文件';`,
            `                    statAdditions.textContent = '+' + msg.stats.additions;`,
            `                    statDeletions.textContent = '-' + msg.stats.deletions;`,
            `                    diffContent.innerHTML = formatDiff(msg.diff);`,
            `                    break;`,
            `                    `,
            `                case 'reviewing':`,
            `                    loading.classList.add('active');`,
            `                    error.classList.remove('active');`,
            `                    loadingText.textContent = msg.message;`,
            `                    reviewBtn.disabled = true;`,
            `                    break;`,
            `                    `,
            `                case 'error':`,
            `                    loading.classList.remove('active');`,
            `                    error.classList.add('active');`,
            `                    error.textContent = msg.message;`,
            `                    getDiffBtn.disabled = false;`,
            `                    reviewBtn.disabled = false;`,
            `                    break;`,
            `                    `,
            `                case 'reviewResult':`,
            `                    loading.classList.remove('active');`,
            `                    error.classList.remove('active');`,
            `                    reviewBtn.disabled = false;`,
            `                    `,
            `                    diffPreviewSection.classList.add('hidden');`,
            `                    reviewResultSection.classList.remove('hidden');`,
            `                    `,
            `                    step1.classList.remove('active');`,
            `                    step2.classList.add('active');`,
            `                    `,
            `                    resultCommitBadge.textContent = msg.commitHash;`,
            `                    reviewContent.innerHTML = markdownToHtml(msg.result);`,
            `                    break;`,
            `                    `,
            `                case 'clear':`,
            `                    resetToStep1();`,
            `                    break;`,
            `            }`,
            `        });`,
            ``,
            `        function formatDiff(diff) {`,
            `            return diff.split('\\n').map(line => {`,
            `                let className = 'diff-line';`,
            `                if (line.startsWith('+') && !line.startsWith('+++')) {`,
            `                    className += ' diff-addition';`,
            `                } else if (line.startsWith('-') && !line.startsWith('---')) {`,
            `                    className += ' diff-deletion';`,
            `                } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) {`,
            `                    className += ' diff-meta';`,
            `                }`,
            `                return '<div class="' + className + '">' + escapeHtml(line) + '</div>';`,
            `            }).join('');`,
            `        }`,
            ``,
            `        function escapeHtml(text) {`,
            `            const div = document.createElement('div');`,
            `            div.textContent = text;`,
            `            return div.innerHTML;`,
            `        }`,
            ``,
            `        function markdownToHtml(md) {`,
            `            return md`,
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