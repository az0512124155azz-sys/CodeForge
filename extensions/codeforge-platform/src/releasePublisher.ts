import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { BuildArtifact, findFreshBuildArtifacts, formatArtifactSize } from './artifacts';
import { GitHubRepository, GitHubService } from './github';
import { OperationState } from './operations';

interface ProjectMetadata {
  name: string;
  version?: string;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseGitHubRemote(remote: string): string | undefined {
  const value = remote.trim().replace(/\.git$/i, '');
  const ssh = /^git@github\.com:([^/]+)\/(.+)$/i.exec(value);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    const sshUrl = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/i.exec(value);
    if (sshUrl) return `${sshUrl[1]}/${sshUrl[2]}`;
  }
  return undefined;
}

function timestamp(): string {
  const date = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function safeTag(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function projectMetadata(root: string): Promise<ProjectMetadata> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return {
      name: parsed.name?.trim() || path.basename(root),
      version: parsed.version?.trim() || undefined
    };
  } catch {
    return { name: path.basename(root) };
  }
}

async function chooseRepository(github: GitHubService): Promise<string | undefined> {
  const repositories = await github.listRepositories();
  const selected = await vscode.window.showQuickPick(repositories.map(repository => ({
    label: repository.full_name,
    description: repository.private ? 'Private' : 'Public',
    detail: repository.description ?? repository.html_url,
    repository
  })), {
    title: 'Publish build to GitHub Release',
    placeHolder: 'Choose the target GitHub repository',
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected?.repository.full_name;
}

async function resolveRepository(root: string, github: GitHubService): Promise<string | undefined> {
  try {
    const origin = await runGit(root, ['remote', 'get-url', 'origin']);
    const parsed = parseGitHubRemote(origin);
    if (parsed) return parsed;
  } catch {
    // The project may not have an origin yet; let the user choose a repository.
  }
  return chooseRepository(github);
}

async function currentBranch(root: string): Promise<string | undefined> {
  try {
    const branch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

interface ArtifactPick extends vscode.QuickPickItem {
  artifact: BuildArtifact;
  picked: boolean;
}

async function selectArtifacts(artifacts: BuildArtifact[]): Promise<BuildArtifact[]> {
  const items: ArtifactPick[] = artifacts.map(artifact => ({
    label: artifact.fileName,
    description: `${artifact.kind} · ${formatArtifactSize(artifact.size)}`,
    detail: artifact.relativePath,
    artifact,
    picked: true
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Publish build artifacts',
    placeHolder: 'Select files to upload as GitHub Release assets',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected?.map(item => item.artifact) ?? [];
}

export async function publishBuildToGitHubRelease(
  workspaceRoot: string,
  buildStartedAt: number,
  github: GitHubService,
  operations: OperationState
): Promise<void> {
  const artifacts = await findFreshBuildArtifacts(workspaceRoot, buildStartedAt);
  if (!artifacts.length) {
    const action = await vscode.window.showWarningMessage(
      'CodeForge did not find a fresh EXE/MSI/ZIP/AppImage/DEB/RPM/DMG/PKG/APK/AAB artifact from the last build.',
      'Artifact settings'
    );
    if (action === 'Artifact settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.build.artifactDirectories');
    }
    return;
  }

  const selectedArtifacts = await selectArtifacts(artifacts);
  if (!selectedArtifacts.length) return;

  const repository = await operations.run('git', 'Resolving GitHub release repository', () => resolveRepository(workspaceRoot, github));
  if (!repository) return;

  const metadata = await projectMetadata(workspaceRoot);
  const defaultTag = metadata.version
    ? `v${metadata.version}-build-${timestamp()}`
    : `build-${timestamp()}`;
  const tagInput = await vscode.window.showInputBox({
    title: `Publish ${metadata.name} to ${repository}`,
    prompt: 'GitHub Release tag. A unique build tag is recommended so older builds remain recoverable.',
    value: defaultTag,
    validateInput: value => safeTag(value) ? undefined : 'Enter a valid Git tag.'
  });
  if (!tagInput) return;
  const tag = safeTag(tagInput);
  const branch = await currentBranch(workspaceRoot);
  const releaseName = `${metadata.name} ${tag}`;

  const totalSize = selectedArtifacts.reduce((total, artifact) => total + artifact.size, 0);
  const confirmation = await vscode.window.showInformationMessage(
    `Publish ${selectedArtifacts.length} build artifact${selectedArtifacts.length === 1 ? '' : 's'} (${formatArtifactSize(totalSize)}) to ${repository} as ${tag}?`,
    { modal: true, detail: 'Binaries will be GitHub Release Assets, not commits in the Git repository.' },
    'Publish Release'
  );
  if (confirmation !== 'Publish Release') return;

  const release = await operations.run('git', `Publishing GitHub Release ${tag}`, async () => {
    const created = await github.createOrGetRelease(repository, tag, releaseName, branch);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Publishing ${tag} to GitHub`,
      cancellable: false
    }, async progress => {
      for (let index = 0; index < selectedArtifacts.length; index++) {
        const artifact = selectedArtifacts[index];
        operations.update('git', `Uploading ${artifact.fileName} (${index + 1}/${selectedArtifacts.length})`);
        progress.report({
          message: `${artifact.fileName} · ${index + 1}/${selectedArtifacts.length}`,
          increment: 100 / selectedArtifacts.length
        });
        await github.uploadReleaseAsset(repository, created.id, artifact.filePath);
      }
    });
    return created;
  });

  const action = await vscode.window.showInformationMessage(
    `CodeForge published ${selectedArtifacts.length} artifact${selectedArtifacts.length === 1 ? '' : 's'} to ${repository} release ${tag}.`,
    'Open GitHub Release'
  );
  if (action === 'Open GitHub Release') {
    await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  }
}
