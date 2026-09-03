import * as vscode from 'vscode';

export type OperationKind = 'build' | 'ai' | 'git';

interface OperationEntry {
  status: string;
  cancel?: () => void | Promise<void>;
}

export interface OperationSnapshot {
  running: boolean;
  status: string;
}

export class OperationState implements vscode.Disposable {
  private readonly active = new Map<OperationKind, OperationEntry>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private runningKey(kind: OperationKind): string {
    return `codeforge.${kind}Running`;
  }

  private statusKey(kind: OperationKind): string {
    return `codeforge.${kind}Status`;
  }

  async initialize(): Promise<void> {
    await Promise.all((['build', 'ai', 'git'] as OperationKind[]).map(kind => this.publish(kind, false, '')));
  }

  private async publish(kind: OperationKind, running: boolean, status: string): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand('setContext', this.runningKey(kind), running),
      vscode.commands.executeCommand('setContext', this.statusKey(kind), running ? status : '')
    ]);
    this.changeEmitter.fire();
  }

  async begin(kind: OperationKind, status: string, cancel?: () => void | Promise<void>): Promise<void> {
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

  async run<T>(kind: OperationKind, status: string, task: () => Promise<T>, cancel?: () => void | Promise<void>): Promise<T> {
    await this.begin(kind, status, cancel);
    try {
      return await task();
    } finally {
      await this.end(kind);
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
