(function () {
    const vscode = acquireVsCodeApi();

    // 页面元素
    const navTabs = document.querySelectorAll('.nav-tab');
    const pages = document.querySelectorAll('.page');

    // 审核页面元素
    const diffSection = document.getElementById('diffSection');
    const diffPreviewSection = document.getElementById('diffPreviewSection');
    const reviewResultSection = document.getElementById('reviewResultSection');
    const loading = document.getElementById('loading');
    const loadingText = document.getElementById('loadingText');
    const error = document.getElementById('error');

    // 按钮
    const getDiffBtn = document.getElementById('getDiffBtn');
    const reviewBtn = document.getElementById('reviewBtn');
    const refreshDiffBtn = document.getElementById('refreshDiffBtn');
    const newReviewBtn = document.getElementById('newReviewBtn');
    const copyDiffBtn = document.getElementById('copyDiffBtn');

    // Diff 显示元素
    const commitBadge = document.getElementById('commitBadge');
    const statFiles = document.getElementById('statFiles');
    const statAdditions = document.getElementById('statAdditions');
    const statDeletions = document.getElementById('statDeletions');
    const diffContent = document.getElementById('diffContent');
    const resultCommitBadge = document.getElementById('resultCommitBadge');
    const reviewContent = document.getElementById('reviewContent');

    // 步骤指示器
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');

    // 设置页面元素
    const apiUrlInput = document.getElementById('apiUrl');
    const apiKeyInput = document.getElementById('apiKey');
    const saveBtn = document.getElementById('saveBtn');

    // 存储原始 diff 文本用于复制
    let currentRawDiff = '';

    // 导航切换
    navTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetPage = tab.dataset.page;

            navTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            pages.forEach(page => page.classList.remove('active'));
            document.getElementById(targetPage + 'Page').classList.add('active');
        });
    });

    // 初始化
    vscode.postMessage({ type: 'getConfig' });

    // 获取 Diff
    getDiffBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'getDiff' });
    });

    // 刷新 Diff
    refreshDiffBtn.addEventListener('click', () => {
        resetToStep1();
        vscode.postMessage({ type: 'getDiff' });
    });

    // 开始 AI 审核
    reviewBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'review' });
    });

    // 新的开始
    newReviewBtn.addEventListener('click', () => {
        resetToStep1();
        saveState({ viewState: 'initial' });
    });

    // 复制 diff
    copyDiffBtn.addEventListener('click', () => {
        if (!currentRawDiff) return;

        navigator.clipboard.writeText(currentRawDiff).then(() => {
            copyDiffBtn.classList.add('copied');
            copyDiffBtn.innerHTML = '<span>✅</span> 已复制';
            setTimeout(() => {
                copyDiffBtn.classList.remove('copied');
                copyDiffBtn.innerHTML = '<span>📋</span> 复制';
            }, 2000);
        }).catch(() => {
            // 降级方案：使用 execCommand
            const textarea = document.createElement('textarea');
            textarea.value = currentRawDiff;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                copyDiffBtn.classList.add('copied');
                copyDiffBtn.innerHTML = '<span>✅</span> 已复制';
                setTimeout(() => {
                    copyDiffBtn.classList.remove('copied');
                    copyDiffBtn.innerHTML = '<span>📋</span> 复制';
                }, 2000);
            } catch (e) {
                // 复制失败，静默处理
            }
            document.body.removeChild(textarea);
        });
    });

    // 保存配置
    saveBtn.addEventListener('click', () => {
        const modelValue = document.getElementById('model').value.trim();

        vscode.postMessage({
            type: 'saveConfig',
            apiUrl: apiUrlInput.value,
            apiKey: apiKeyInput.value,
            model: modelValue || 'gpt-3.5-turbo'
        });
    });

    // 重置到第一步
    function resetToStep1() {
        diffSection.classList.remove('hidden');
        diffPreviewSection.classList.add('hidden');
        reviewResultSection.classList.add('hidden');
        error.classList.remove('active');
        step1.classList.add('active');
        step2.classList.remove('active');
        currentRawDiff = '';
    }

    // ---- 状态持久化 ----
    function saveState(state) {
        vscode.setState(state);
    }

    function restoreState() {
        var state = vscode.getState();
        if (!state) return;

        if (state.viewState === 'diffPreview' && state.diff) {
            diffSection.classList.add('hidden');
            diffPreviewSection.classList.remove('hidden');
            reviewResultSection.classList.add('hidden');
            step1.classList.add('active');
            step2.classList.remove('active');

            currentRawDiff = state.diff;
            commitBadge.textContent = state.commitHash || '';
            statFiles.textContent = (state.stats ? state.stats.files : 0) + ' 个文件';
            statAdditions.textContent = '+' + (state.stats ? state.stats.additions : 0);
            statDeletions.textContent = '-' + (state.stats ? state.stats.deletions : 0);
            diffContent.innerHTML = formatDiff(state.diff);
        } else if (state.viewState === 'reviewResult' && state.result) {
            diffSection.classList.add('hidden');
            diffPreviewSection.classList.add('hidden');
            reviewResultSection.classList.remove('hidden');
            step1.classList.remove('active');
            step2.classList.add('active');

            resultCommitBadge.textContent = state.commitHash || '';
            reviewContent.innerHTML = markdownToHtml(state.result);
        }
    }

    // 处理消息
    window.addEventListener('message', event => {
        const msg = event.data;

        switch (msg.type) {
            case 'config':
                if (msg.apiUrl) apiUrlInput.value = msg.apiUrl;
                if (msg.apiKey) {
                    apiKeyInput.value = msg.apiKey;
                    apiKeyInput.placeholder = '已配置 (点击修改)';
                }
                if (msg.model) {
                    document.getElementById('model').value = msg.model;
                }
                break;

            case 'loading':
                loading.classList.add('active');
                error.classList.remove('active');
                loadingText.textContent = msg.message;
                getDiffBtn.disabled = true;
                break;

            case 'diffPreview':
                loading.classList.remove('active');
                error.classList.remove('active');
                getDiffBtn.disabled = false;

                diffSection.classList.add('hidden');
                diffPreviewSection.classList.remove('hidden');
                reviewResultSection.classList.add('hidden');

                step1.classList.add('active');
                step2.classList.remove('active');

                currentRawDiff = msg.diff;
                commitBadge.textContent = msg.commitHash;
                statFiles.textContent = msg.stats.files + ' 个文件';
                statAdditions.textContent = '+' + msg.stats.additions;
                statDeletions.textContent = '-' + msg.stats.deletions;
                diffContent.innerHTML = formatDiff(msg.diff);

                saveState({
                    viewState: 'diffPreview',
                    diff: msg.diff,
                    commitHash: msg.commitHash,
                    stats: msg.stats
                });
                break;

            case 'reviewing':
                loading.classList.add('active');
                error.classList.remove('active');
                loadingText.textContent = msg.message;
                reviewBtn.disabled = true;
                break;

            case 'error':
                loading.classList.remove('active');
                error.classList.add('active');
                error.textContent = msg.message;
                getDiffBtn.disabled = false;
                reviewBtn.disabled = false;
                break;

            case 'reviewResult':
                loading.classList.remove('active');
                error.classList.remove('active');
                reviewBtn.disabled = false;

                diffPreviewSection.classList.add('hidden');
                reviewResultSection.classList.remove('hidden');

                step1.classList.remove('active');
                step2.classList.add('active');

                resultCommitBadge.textContent = msg.commitHash;
                reviewContent.innerHTML = markdownToHtml(msg.result);

                saveState({
                    viewState: 'reviewResult',
                    result: msg.result,
                    commitHash: msg.commitHash
                });
                break;

            case 'clear':
                resetToStep1();
                saveState({ viewState: 'initial' });
                break;
        }
    });

    // 格式化 diff 显示
    function formatDiff(diff) {
        return diff.split('\n').map(line => {
            let className = 'diff-line';
            if (line.startsWith('+') && !line.startsWith('+++')) {
                className += ' diff-addition';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                className += ' diff-deletion';
            } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('@@')) {
                className += ' diff-meta';
            }
            return '<div class="' + className + '">' + escapeHtml(line) + '</div>';
        }).join('');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Markdown 转 HTML（修复列表和块级元素渲染）
    function markdownToHtml(md) {
        var lines = md.split('\n');
        var html = '';
        var inUl = false;
        var inOl = false;
        var inBlockquote = false;
        var inPre = false;
        var preContent = '';
        var preLang = '';

        function closeLists() {
            if (inUl) { html += '</ul>'; inUl = false; }
            if (inOl) { html += '</ol>'; inOl = false; }
        }

        function closeBlocks() {
            closeLists();
            if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
        }

        function processInline(text) {
            return text
                .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/~~(.*?)~~/g, '<del>$1</del>')
                .replace(/`([^`]+)`/g, '<code>$1</code>');
        }

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            // 代码块处理
            if (line.match(/^```/)) {
                if (!inPre) {
                    closeBlocks();
                    inPre = true;
                    preLang = line.replace(/^```/, '').trim();
                    preContent = '';
                    continue;
                } else {
                    html += '<pre><code>' + escapeHtml(preContent) + '</code></pre>';
                    inPre = false;
                    preContent = '';
                    preLang = '';
                    continue;
                }
            }

            if (inPre) {
                preContent += (preContent ? '\n' : '') + line;
                continue;
            }

            // 标题
            if (line.match(/^### (.+)/)) {
                closeBlocks();
                html += '<h3>' + processInline(line.replace(/^### /, '')) + '</h3>';
                continue;
            }
            if (line.match(/^## (.+)/)) {
                closeBlocks();
                html += '<h2>' + processInline(line.replace(/^## /, '')) + '</h2>';
                continue;
            }
            if (line.match(/^# (.+)/)) {
                closeBlocks();
                html += '<h1>' + processInline(line.replace(/^# /, '')) + '</h1>';
                continue;
            }

            // 空行 → 关闭列表和引用
            if (line.trim() === '') {
                closeBlocks();
                continue;
            }

            // 引用
            if (line.match(/^> (.+)/)) {
                closeLists();
                if (!inBlockquote) { html += '<blockquote>'; inBlockquote = true; }
                html += '<p>' + processInline(line.replace(/^> /, '')) + '</p>';
                continue;
            }

            // 无序列表
            var ulMatch = line.match(/^- (.+)/);
            if (ulMatch) {
                if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                if (inOl) { html += '</ol>'; inOl = false; }
                if (!inUl) { html += '<ul>'; inUl = true; }
                html += '<li>' + processInline(ulMatch[1]) + '</li>';
                continue;
            }

            // 有序列表
            var olMatch = line.match(/^\d+\. (.+)/);
            if (olMatch) {
                if (inBlockquote) { html += '</blockquote>'; inBlockquote = false; }
                if (inUl) { html += '</ul>'; inUl = false; }
                if (!inOl) { html += '<ol>'; inOl = true; }
                html += '<li>' + processInline(olMatch[1]) + '</li>';
                continue;
            }

            // 普通段落
            closeBlocks();
            html += '<p>' + processInline(line) + '</p>';
        }

        // 关闭未闭合的标签
        if (inPre) { html += '<pre><code>' + escapeHtml(preContent) + '</code></pre>'; }
        closeBlocks();

        return html;
    }

    // 恢复上次的状态
    restoreState();
})();