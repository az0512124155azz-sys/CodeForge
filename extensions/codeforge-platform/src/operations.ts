import * as vscode from 'vscode';

export type OperationKind = 'build' | 'ai' | 'git';

type CancelOperation = () => unknown | Promise<unknown>;

interface OperationEntry {
  status: string;
  cancel?: CancelOperation;
}

export interface OperationSnapshot {
  running: boolean;
  status: string;
}

let currentOperationState: OperationState | undefined;

export function getCurrentOperationState(): OperationState | undefined {
  return currentOperationState;
}

export class OperationState implements vscode.Disposable {
  private readonly active = new Map<OperationKind, OperationEntry>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private dashboardRegistration: vscode.Disposable | undefined;
  private dashboard: vscode.Disposable | undefined;
  readonly onDidChange = this.changeEmitter.event;

  constructor() {
    currentOperationState = this;
  }

  private runningKey(kind: OperationKind): string {
    return `codeforge.${kind}Running`;
  }

  private statusKey(kind: OperationKind): string {
    return `codeforge.${kind}Status`;
  }

  async initialize(): Promise<void> {
    await Promise.all((['build', 'ai', 'git'] as OperationKind[]).map(kind => this.publish(kind, false, '')));
    const { CodeForgeDashboard } = await import('./dashboard');
    const dashboard = new CodeForgeDashboard(this);
    this.dashboard = dashboard;
    this.dashboardRegistration = vscode.window.registerTreeDataProvider('codeforge.dashboard', dashboard);
  }

  private async publish(kind: OperationKind, running: boolean, status: string): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', this.runningKey(kind), running),
      vscode.commands.executeCommand('setContext', this.statusKey(kind), running ? status : '')
    ]);
    this.changeEmitter.fire();
  }

  async begin(kind: OperationKind, status: string, cancel?: CancelOperation): Promise<void> {
    this.active.set(kind, { status, cancel });
    await this.publish(kind, true, status);
  }

  update(kind: OperationKind, status: string): void {
    const current = this.active.get(kind);
    if (!current) return;
    current.status = status;
    void vscode.commands.executeCommand('setContext', this.statusKey(kind), status);
    this.changeEmitter.fire();
  }

  async end(kind: OperationKind): Promise<void> {
    this.active.delete(kind);
    await this.publish(kind, false, '');
  }

  isRunning(kind: OperationKind): boolean {
    return this.active.has(kind);
  }

  snapshot(kind: OperationKind): OperationSnapshot {
    const current = this.active.get(kind);
    return current ? { running: true, status: current.status } : { running: false, status: '' };
  }

  async cancelAll(): Promise<void> {
    const entries = [...this.active.entries()];
    for (const [, entry] of entries) {
      try {
        await entry.cancel?.();
      } catch {
        // Shutdown cancellation is best-effort. The process will terminate any
        // remaining extension-host work after the lifecycle veto is released.
      }
    }
    await Promise.all(entries.map(([kind]) => this.end(kind)));
  }

  async run<T>(kind: OperationKind, status: string, task: () => Promise<T>, cancel?: CancelOperation): Promise<T> {
    await this.begin(kind, status, cancel);
    try {
      return await task();
    } finally {
      await this.end(kind);
    }
  }

  dispose(): void {
    if (currentOperationState === this) currentOperationState = undefined;
    this.dashboardRegistration?.dispose();
    this.dashboard?.dispose();
    this.changeEmitter.dispose();
  }
}
