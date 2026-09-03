import * as vscode from 'vscode';
import { activate as activatePlatform, deactivate as deactivatePlatform } from './extension';
import { findFreshBuildArtifacts } from './artifacts';
import { GitHubService } from './github';
import { getCurrentOperationState } from './operations';
import { publishBuildToGitHubRelease } from './releasePublisher';

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function publishRecentBuild(context: vscode.ExtensionContext, buildStartedAt?: number): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage('Open a project folder before publishing a CodeForge build.');
    return;
  }

  const operations = getCurrentOperationState();
  if (!operations) {
    void vscode.window.showErrorMessage('CodeForge operation manager is not ready yet.');
    return;
  }

  const recentMinutes = Math.max(1, Math.min(1440, vscode.workspace.getConfiguration('codeforge.build').get<number>('recentArtifactMinutes', 60)));
  const cutoff = buildStartedAt ?? (Date.now() - recentMinutes * 60 * 1000);
  const github = new GitHubService(context);

  try {
    await publishBuildToGitHubRelease(root, cutoff, github, operations);
  } catch (error) {
    void vscode.window.showErrorMessage(`CodeForge GitHub Release: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await activatePlatform(context);

  const operations = getCurrentOperationState();
  if (!operations) {
    throw new Error('CodeForge platform activated without an operation manager.');
  }

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.publishRecentBuild', async () => publishRecentBuild(context)));

  let buildWasRunning = operations.snapshot('build').running;
  let buildStartedAt: number | undefined = buildWasRunning ? Date.now() : undefined;
  let offerInProgress = false;

  context.subscriptions.push(operations.onDidChange(async () => {
    const running = operations.snapshot('build').running;
    if (running && !buildWasRunning) {
      buildStartedAt = Date.now();
    }

    if (!running && buildWasRunning && buildStartedAt && !offerInProgress) {
      const finishedBuildStart = buildStartedAt;
      buildStartedAt = undefined;
      offerInProgress = true;
      try {
        if (vscode.workspace.getConfiguration('codeforge.github').get<boolean>('offerReleaseAfterBuild', true)) {
          const root = workspaceRoot();
          if (root) {
            const artifacts = await findFreshBuildArtifacts(root, finishedBuildStart);
            if (artifacts.length) {
              const total = artifacts.length;
              const action = await vscode.window.showInformationMessage(
                `CodeForge detected ${total} new build artifact${total === 1 ? '' : 's'}. Publish this build to GitHub Release?`,
                'Publish to GitHub Release',
                'Not now'
              );
              if (action === 'Publish to GitHub Release') {
                await publishRecentBuild(context, finishedBuildStart);
              }
            }
          }
        }
      } finally {
        offerInProgress = false;
      }
    }

    buildWasRunning = running;
  }));
}

export function deactivate(): void {
  deactivatePlatform();
}
