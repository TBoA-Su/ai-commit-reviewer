import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getGitDiff, getLastCommitHash } from './git';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _currentDiff: string = '';
    private _currentCommitHash: string = '';

    constructor(extensionUri: vscode.Uri) {
        this._extensionUri = extensionUri;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
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
            }
        });

        this._sendConfigToWebview();
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // 获取资源 URI
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'style.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')
        );

        // 生成 nonce（内容安全策略）
        const nonce = getNonce();

        // 读取 HTML 模板
        const htmlPath = path.join(this._extensionUri.fsPath, 'media', 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        // 替换模板变量
        html = html.replace(/\${cspSource}/g, webview.cspSource);
        html = html.replace(/\${nonce}/g, nonce);
        html = html.replace(/\${styleUri}/g, styleUri.toString());
        html = html.replace(/\${scriptUri}/g, scriptUri.toString());

        return html;
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

            const stats = this._analyzeDiff(diff);

            this._view.webview.postMessage({
                type: 'diffPreview',
                commitHash: this._currentCommitHash,
                diff: diff,
                stats: stats
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
            error?: {
                message: string;
                type: string;
            };
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

        // 检测 API 类型
        const url = apiUrl.toLowerCase();
        const isAzure = url.includes('azure') || url.includes('microsoft');
        const isClaude = url.includes('anthropic') || url.includes('claude');
        const isOllama = url.includes('ollama') || url.includes('localhost') || url.includes('127.0.0.1');

        let body: any;
        let headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        };

        // Azure 特殊处理
        if (isAzure) {
            headers = {
                'Content-Type': 'application/json',
                'api-key': apiKey
            };
        }

        // Claude 特殊处理
        if (isClaude) {
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            };
            body = {
                model: model,
                max_tokens: 4000,
                messages: [
                    { role: 'user', content: prompt }
                ]
            };
            // Claude 使用 /v1/messages 端点
            if (!apiUrl.includes('/messages')) {
                apiUrl = apiUrl.replace(/\/v1\/.*$/, '/v1/messages');
            }
        } else {
            // 默认使用 Chat Completions API 格式（OpenAI、Azure、兼容服务）
            body = {
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: '你是一位专业的代码审查专家，擅长发现代码中的问题并提供建设性的改进建议。请用中文回复。'
                    },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 4000,
                temperature: 0.3,
                top_p: 1,
                frequency_penalty: 0,
                presence_penalty: 0
            };
        }

        console.log('API URL:', apiUrl);
        console.log('Headers:', JSON.stringify(headers, null, 2));
        console.log('Request body:', JSON.stringify(body, null, 2));

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            const responseText = await response.text();
            console.log('Response status:', response.status);
            console.log('Response body:', responseText);

            if (!response.ok) {
                let errorMsg = `API 请求失败 (${response.status})`;
                try {
                    const errorData = JSON.parse(responseText);
                    errorMsg += `: ${errorData.error?.message || errorData.message || responseText}`;
                } catch {
                    errorMsg += `: ${responseText}`;
                }
                throw new Error(errorMsg);
            }

            const data: AIResponse = JSON.parse(responseText);

            if (data.error) {
                throw new Error(`API 错误: ${data.error.message}`);
            }

            // 解析不同格式的响应
            if (data.choices && data.choices[0]) {
                if (data.choices[0].message?.content) {
                    return data.choices[0].message.content;
                }
                if (data.choices[0].text) {
                    return data.choices[0].text;
                }
            }

            // Claude 格式
            if ((data as any).content && (data as any).content[0]?.text) {
                return (data as any).content[0].text;
            }

            return JSON.stringify(data, null, 2);

        } catch (error: any) {
            console.error('API call error:', error);
            throw error;
        }
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}