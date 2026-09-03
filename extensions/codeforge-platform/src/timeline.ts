import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { randomBytes } from 'crypto';

interface GitResult {
  stdout: string;
  stderr: string;
}

export interface TimelineCheckpoint {
  id: string;
  ref: string;
  sha: string;
  reason: string;
  createdAt: number;
  repositoryRoot: string;
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const result = { stdout: stdout ?? '', stderr: stderr ?? '' };
      if (error) {
        const detail = result.stderr.trim() || result.stdout.trim() || error.message;
        reject(new Error(`git ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve(result);
    });
  });
}

function timestampForBranch(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'work';
}

function checkpointLabel(checkpoint: TimelineCheckpoint): string {
  return new Date(checkpoint.createdAt).toLocaleString();
}

export class SafetyTimeline {
  private static readonly storageKey = 'codeforge.timeline.checkpoints.v1';
  private readonly output = vscode.window.createOutputChannel('CodeForge Safety Timeline');

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.output);
  }

  private configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('codeforge.timeline');
  }

  private maxCheckpoints(): number {
    return Math.max(5, Math.min(250, this.configuration().get<number>('maxCheckpoints', 50)));
  }

  private checkpoints(): TimelineCheckpoint[] {
    return this.context.globalState.get<TimelineCheckpoint[]>(SafetyTimeline.storageKey, []);
  }

  private async saveCheckpoints(checkpoints: TimelineCheckpoint[]): Promise<void> {
    await this.context.globalState.update(SafetyTimeline.storageKey, checkpoints);
  }

  async repositoryRoot(): Promise<string | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return undefined;
    try {
      const result = await runGit(folder, ['rev-parse', '--show-toplevel']);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async currentHead(root: string): Promise<string | undefined> {
    try {
      const result = await runGit(root, ['rev-parse', '--verify', 'HEAD']);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async removeTempIndex(indexPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(indexPath), { useTrash: false });
    } catch {
      // The temporary index is best-effort cleanup only.
    }
  }

  async createCheckpoint(reason: string, silent = false): Promise<TimelineCheckpoint | undefined> {
    const root = await this.repositoryRoot();
    if (!root) {
      if (!silent) void vscode.window.showWarningMessage('CodeForge Safety Timeline requires a Git repository.');
      return undefined;
    }

    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const ref = `refs/codeforge/checkpoints/${id}`;
    const tempIndex = path.join(this.context.globalStorageUri.fsPath, `timeline-index-${id}`);
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndex };

    try {
      const head = await this.currentHead(root);
      if (head) {
        await runGit(root, ['read-tree', head], env);
      } else {
        await runGit(root, ['read-tree', '--empty'], env);
      }

      await runGit(root, ['add', '-A', '--', '.'], env);
      const tree = (await runGit(root, ['write-tree'], env)).stdout.trim();
      if (!tree) throw new Error('Git did not return a tree for the CodeForge checkpoint.');

      const commitArgs = ['commit-tree', tree];
      if (head) commitArgs.push('-p', head);
      commitArgs.push('-m', `CodeForge checkpoint: ${reason}`);
      const sha = (await runGit(root, commitArgs, env)).stdout.trim();
      if (!sha) throw new Error('Git did not return a checkpoint commit.');
      await runGit(root, ['update-ref', ref, sha]);

      const checkpoint: TimelineCheckpoint = {
        id,
        ref,
        sha,
        reason,
        createdAt: Date.now(),
        repositoryRoot: root
      };

      const existing = this.checkpoints().filter(item => item.repositoryRoot !== root || item.sha !== sha || item.reason !== reason);
      const next = [checkpoint, ...existing];
      const keep = next.slice(0, this.maxCheckpoints());
      const prune = next.slice(this.maxCheckpoints());
      await this.saveCheckpoints(keep);

      for (const old of prune) {
        if (old.repositoryRoot === root) {
          try {
            await runGit(root, ['update-ref', '-d', old.ref]);
          } catch {
            // A stale ref should not make a new checkpoint fail.
          }
        }
      }

      this.output.appendLine(`${checkpointLabel(checkpoint)}  ${sha.slice(0, 12)}  ${reason}`);
      if (!silent) void vscode.window.showInformationMessage(`CodeForge checkpoint created: ${reason}`);
      return checkpoint;
    } finally {
      await this.removeTempIndex(tempIndex);
    }
  }

  private async checkpointAction(checkpoint: TimelineCheckpoint): Promise<void> {
    const action = await vscode.window.showQuickPick([
      { label: '$(history) Restore this checkpoint', id: 'restore' },
      { label: '$(compare-changes) Show diff summary', id: 'diff' },
      { label: '$(copy) Copy checkpoint SHA', id: 'copy' }
    ], {
      title: `CodeForge Safety Timeline · ${checkpointLabel(checkpoint)}`,
      placeHolder: checkpoint.reason
    });
    if (!action) return;

    if (action.id === 'copy') {
      await vscode.env.clipboard.writeText(checkpoint.sha);
      return;
    }
    if (action.id === 'diff') {
      const root = await this.repositoryRoot();
      if (!root || root !== checkpoint.repositoryRoot) throw new Error('Open the repository that owns this checkpoint first.');
      const result = await runGit(root, ['diff', '--stat', 'HEAD', checkpoint.sha]);
      this.output.show(true);
      this.output.appendLine(`\nDiff HEAD -> ${checkpoint.sha.slice(0, 12)} (${checkpoint.reason})`);
      this.output.appendLine(result.stdout || '(no tracked-file differences)');
      return;
    }
    await this.restoreCheckpoint(checkpoint);
  }

  async show(): Promise<void> {
    const root = await this.repositoryRoot();
    if (!root) {
      void vscode.window.showWarningMessage('Open a Git repository to use CodeForge Safety Timeline.');
      return;
    }
    const checkpoints = this.checkpoints().filter(item => item.repositoryRoot === root);
    if (!checkpoints.length) {
      const action = await vscode.window.showInformationMessage('No CodeForge checkpoints exist for this repository yet.', 'Create checkpoint');
      if (action === 'Create checkpoint') await this.createCheckpoint('Manual checkpoint');
      return;
    }

    const selected = await vscode.window.showQuickPick(checkpoints.map(checkpoint => ({
      label: checkpointLabel(checkpoint),
      description: checkpoint.sha.slice(0, 12),
      detail: checkpoint.reason,
      checkpoint
    })), {
      title: 'CodeForge Safety Timeline',
      placeHolder: 'Choose a recoverable checkpoint',
      matchOnDescription: true,
      matchOnDetail: true
    });
    if (selected) await this.checkpointAction(selected.checkpoint);
  }

  async restoreCheckpoint(checkpoint: TimelineCheckpoint): Promise<void> {
    const root = await this.repositoryRoot();
    if (!root || root !== checkpoint.repositoryRoot) {
      throw new Error('Open the repository that owns this checkpoint first.');
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Restore tracked and checkpointed files to "${checkpoint.reason}"? Extra ignored/untracked files that are not in the checkpoint will not be deleted.`,
      { modal: true },
      'Create safety checkpoint and restore'
    );
    if (confirmation !== 'Create safety checkpoint and restore') return;

    await this.createCheckpoint(`Before restore to ${checkpoint.sha.slice(0, 12)}`, true);
    await runGit(root, ['restore', '--source', checkpoint.sha, '--staged', '--worktree', '--', '.']);
    void vscode.window.showInformationMessage(`CodeForge restored checkpoint ${checkpoint.sha.slice(0, 12)}. Your branch pointer was not moved.`);
  }

  async restoreLatest(): Promise<void> {
    const root = await this.repositoryRoot();
    if (!root) return void vscode.window.showWarningMessage('Open a Git repository first.');
    const checkpoint = this.checkpoints().find(item => item.repositoryRoot === root);
    if (!checkpoint) return void vscode.window.showInformationMessage('No CodeForge checkpoint exists for this repository.');
    await this.restoreCheckpoint(checkpoint);
  }

  async createAIBranch(task: string): Promise<string | undefined> {
    const root = await this.repositoryRoot();
    if (!root) {
      void vscode.window.showWarningMessage('CodeForge AI branches require a Git repository.');
      return undefined;
    }
    const head = await this.currentHead(root);
    if (!head) {
      void vscode.window.showWarningMessage('Create the first Git commit before starting an isolated CodeForge AI branch.');
      return undefined;
    }

    await this.createCheckpoint(`Before AI task: ${task}`, true);
    const branch = `codeforge/ai/${safeSlug(task)}-${timestampForBranch()}`;
    await runGit(root, ['switch', '-c', branch]);
    void vscode.window.showInformationMessage(`CodeForge created isolated AI branch: ${branch}`);
    return branch;
  }
}
