import * as vscode from 'vscode';
import { OperationKind, OperationState } from './operations';

class DashboardItem extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    icon: vscode.ThemeIcon,
    command?: string,
    tooltip?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = icon;
    this.tooltip = tooltip ?? description ?? label;
    if (command) {
      this.command = { command, title: label };
    }
  }
}

function compactStatus(value: string): string {
  return value.length > 75 ? `${value.slice(0, 72)}…` : value;
}

export class CodeForgeDashboard implements vscode.TreeDataProvider<DashboardItem>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<DashboardItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly operationListener: vscode.Disposable;

  constructor(private readonly operations: OperationState) {
    this.operationListener = operations.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: DashboardItem): vscode.TreeItem {
    return element;
  }

  getChildren(): DashboardItem[] {
    const build = this.operations.snapshot('build');
    const ai = this.operations.snapshot('ai');
    const git = this.operations.snapshot('git');

    return [
      this.operationItem('build', build.running, build.status),
      this.operationItem('ai', ai.running, ai.status),
      this.operationItem('git', git.running, git.status),
      new DashboardItem('MCP', 'servers · tools · resources', new vscode.ThemeIcon('server-process'), 'codeforge.openMCP', 'Manage CodeForge MCP connections and trust'),
      new DashboardItem('Safety Timeline', 'checkpoints · restore · AI branches', new vscode.ThemeIcon('history'), 'codeforge.timeline.show', 'Open recoverable CodeForge Git checkpoints'),
      new DashboardItem('CodeForge Settings', 'AI · GitHub · MCP · builds', new vscode.ThemeIcon('settings-gear'), 'workbench.action.openSettings', 'Open CodeForge settings')
    ];
  }

  private operationItem(kind: OperationKind, running: boolean, status: string): DashboardItem {
    if (kind === 'build') {
      return running
        ? new DashboardItem('Build running', compactStatus(status), new vscode.ThemeIcon('loading~spin'), 'codeforge.openBuildOutput', status)
        : new DashboardItem('Build Center', 'ready', new vscode.ThemeIcon('tools'), 'codeforge.openBuildCenter', 'Detect and build Windows, Linux, macOS and Android projects');
    }
    if (kind === 'ai') {
      return running
        ? new DashboardItem('AI working', compactStatus(status), new vscode.ThemeIcon('loading~spin'), undefined, status)
        : new DashboardItem('AI', 'Ollama · Bionic', new vscode.ThemeIcon('sparkle'), 'codeforge.openAI', 'Open CodeForge AI controls');
    }
    return running
      ? new DashboardItem('GitHub / Git working', compactStatus(status), new vscode.ThemeIcon('loading~spin'), undefined, status)
      : new DashboardItem('GitHub', 'repositories · push · pull', new vscode.ThemeIcon('github'), 'codeforge.openGitHub', 'Open CodeForge GitHub controls');
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.operationListener.dispose();
    this.changeEmitter.dispose();
  }
}
