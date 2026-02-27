import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext) {
    const sidebarProvider = new SidebarProvider(context.extensionUri, context);
    
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'aiCommitReviewer.sidebar',
            sidebarProvider
        )
    );

    // 注册命令
    context.subscriptions.push(
        vscode.commands.registerCommand('aiCommitReviewer.review', () => {
            sidebarProvider.reviewCurrentCommit();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('aiCommitReviewer.refresh', () => {
            sidebarProvider.refresh();
        })
    );
}

export function deactivate() {}