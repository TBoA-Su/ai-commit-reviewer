import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function getGitDiff(repoPath: string): Promise<string> {
    try {
        // 首先尝试获取最近一次提交的 diff（适用于已提交的情况）
        try {
            const { stdout: lastCommitDiff } = await execAsync('git diff HEAD~1 HEAD --no-color', {
                cwd: repoPath,
                maxBuffer: 10 * 1024 * 1024
            });
            if (lastCommitDiff && lastCommitDiff.trim()) {
                return lastCommitDiff;
            }
        } catch (e) {
            // 可能是第一次提交，没有 HEAD~1，继续尝试其他方式
            console.log('No parent commit, trying other methods...');
        }

        // 尝试获取 staged changes（暂存区）
        const { stdout: staged } = await execAsync('git diff --cached --no-color', {
            cwd: repoPath,
            maxBuffer: 10 * 1024 * 1024
        });
        if (staged && staged.trim()) {
            return staged;
        }

        // 尝试获取 working tree 的 changes（未暂存）
        const { stdout: working } = await execAsync('git diff --no-color', {
            cwd: repoPath,
            maxBuffer: 10 * 1024 * 1024
        });
        if (working && working.trim()) {
            return working;
        }

        // 如果都没有，尝试获取最近一次提交的统计信息来判断是否有 commit
        try {
            const { stdout: log } = await execAsync('git log -1 --oneline', {
                cwd: repoPath
            });
            if (log && log.trim()) {
                // 有 commit 但没有 diff，可能是空提交或合并提交
                // 尝试获取该提交本身的变更
                const { stdout: commitDiff } = await execAsync('git show HEAD --no-color', {
                    cwd: repoPath,
                    maxBuffer: 10 * 1024 * 1024
                });
                if (commitDiff && commitDiff.trim()) {
                    return commitDiff;
                }
            }
        } catch (e) {
            // 没有 commit 历史
        }

        return '';
    } catch (error: any) {
        throw new Error(`Git 命令执行失败: ${error.message}`);
    }
}

export async function getLastCommitHash(repoPath: string): Promise<string | null> {
    try {
        // 首先尝试获取 HEAD
        const { stdout: head } = await execAsync('git rev-parse HEAD', {
            cwd: repoPath
        });
        if (head && head.trim()) {
            return head.trim();
        }
    } catch (e) {
        // 没有 HEAD，可能是新仓库
    }

    // 尝试获取最近提交的 hash（用于刚提交的情况）
    try {
        const { stdout } = await execAsync('git log -1 --format=%H', {
            cwd: repoPath
        });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

export async function getCommitMessage(repoPath: string): Promise<string> {
    try {
        const { stdout } = await execAsync('git log -1 --pretty=%B', {
            cwd: repoPath
        });
        return stdout.trim();
    } catch {
        return '';
    }
}

// 新增：检查是否有任何变更（包括已提交、暂存和未暂存）
export async function hasAnyChanges(repoPath: string): Promise<boolean> {
    try {
        // 检查是否有 staged changes
        const { stdout: staged } = await execAsync('git diff --cached --quiet || echo "has_changes"', {
            cwd: repoPath
        });
        if (staged.includes('has_changes')) return true;

        // 检查是否有 unstaged changes
        const { stdout: unstaged } = await execAsync('git diff --quiet || echo "has_changes"', {
            cwd: repoPath
        });
        if (unstaged.includes('has_changes')) return true;

        // 检查是否有 commit 历史
        try {
            await execAsync('git log -1 --oneline', { cwd: repoPath });
            return true; // 有 commit 历史，视为有变更记录
        } catch {
            return false;
        }
    } catch {
        return false;
    }
}