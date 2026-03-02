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

                commitBadge.textContent = msg.commitHash;
                statFiles.textContent = msg.stats.files + ' 个文件';
                statAdditions.textContent = '+' + msg.stats.additions;
                statDeletions.textContent = '-' + msg.stats.deletions;
                diffContent.innerHTML = formatDiff(msg.diff);
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
                break;

            case 'clear':
                resetToStep1();
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

    // Markdown 转 HTML
    function markdownToHtml(md) {
        return md
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/\*\*\*(.*?)\*\*\*/gim, '<strong><em>$1</em></strong>')
            .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/gim, '<em>$1</em>')
            .replace(/~~(.*?)~~/gim, '<del>$1</del>')
            .replace(/```([\s\S]*?)```/gim, '<pre><code>$1</code></pre>')
            .replace(/`([^`]+)`/gim, '<code>$1</code>')
            .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
            .replace(/^- (.*$)/gim, '<ul><li>$1</li></ul>')
            .replace(/^\d+\. (.*$)/gim, '<ol><li>$1</li></ol>')
            .replace(/\n/gim, '<br>');
    }
})();