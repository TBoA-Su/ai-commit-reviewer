import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function getGitDiff(repoPath: string): Promise<string> {
    try {
        // 首先尝试获取 staged changes
        const { stdout: staged } = await execAsync('git diff --cached --no-color', {
            cwd: repoPath,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
        
        if (staged && staged.trim()) {
            return staged;
        }
        
        // 如果没有 staged changes，获取最近一次 commit 的 diff
        const { stdout: lastCommit } = await execAsync('git diff HEAD~1 HEAD --no-color', {
            cwd: repoPath,
            maxBuffer: 10 * 1024 * 1024
        });
        
        if (lastCommit && lastCommit.trim()) {
            return lastCommit;
        }
        
        // 如果都没有，获取 working tree 的 changes
        const { stdout: working } = await execAsync('git diff --no-color', {
            cwd: repoPath,
            maxBuffer: 10 * 1024 * 1024
        });
        
        return working || '';
    } catch (error) {
        // 可能是第一次提交，没有 HEAD~1
        try {
            const { stdout } = await execAsync('git diff --no-color', {
                cwd: repoPath,
                maxBuffer: 10 * 1024 * 1024
            });
            return stdout || '';
        } catch (e) {
            throw new Error('无法获取 Git diff，请确保这是一个 Git 仓库');
        }
    }
}

export async function getLastCommitHash(repoPath: string): Promise<string | null> {
    try {
        const { stdout } = await execAsync('git rev-parse HEAD', {
            cwd: repoPath
        });
        return stdout.trim();
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