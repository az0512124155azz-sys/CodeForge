import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { AIAnalysisResult, AIService, sanitizeDiagnosticText } from './ai';
import { BuildArtifact, findFreshBuildArtifacts, formatArtifactSize } from './artifacts';
import { GitHubRepository, GitHubService } from './github';
import { addMCPServer, browseMCPResources, MCPPermissionBroker, openMCPConfiguration, openMCPControlCenter, openMCPManager, showInstalledMCPServers } from './mcp';
import { OperationState } from './operations';
import { SafetyTimeline } from './timeline';

interface BuildRecipe {
  id: string;
  label: string;
  target: 'windows' | 'linux' | 'macos' | 'android' | 'generic';
  command: string;
  args: string[];
  cwd: string;
}

interface BuildResult {
  recipe: BuildRecipe;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  log: string;
  stages: string[];
  artifacts: BuildArtifact[];
}

interface BuildHistoryEntry {
  id: string;
  recipe: Pick<BuildRecipe, 'id' | 'label' | 'target' | 'command' | 'args'>;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  stages: string[];
  diagnostics: string[];
  artifacts: BuildArtifact[];
}

const BUILD_HISTORY_KEY = 'codeforge.build.detailedHistory';

let activeBuild: ChildProcessWithoutNullStreams | undefined;
let lastBuild: BuildResult | undefined;
let lastAnalysis: AIAnalysisResult | undefined;

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function exists(root: string, relativePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, relativePath)));
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    return JSON.parse(Buffer.from(raw).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function detectBuildRecipes(root: string): Promise<BuildRecipe[]> {
  const recipes: BuildRecipe[] = [];
  const isWindows = process.platform === 'win32';

  if (await exists(root, 'package.json')) {
    const pkg = await readJson<{ scripts?: Record<string, string> }>(path.join(root, 'package.json'));
    if (pkg?.scripts?.build) recipes.push({ id: 'npm-build', label: 'npm build', target: 'generic', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build'], cwd: root });
    if (pkg?.scripts?.['build:win']) recipes.push({ id: 'npm-build-win', label: 'Windows build', target: 'windows', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:win'], cwd: root });
    if (pkg?.scripts?.['build:linux']) recipes.push({ id: 'npm-build-linux', label: 'Linux build', target: 'linux', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:linux'], cwd: root });
    if (pkg?.scripts?.['build:mac']) recipes.push({ id: 'npm-build-mac', label: 'macOS build', target: 'macos', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:mac'], cwd: root });
  }

  if (await exists(root, 'gradlew') || await exists(root, 'gradlew.bat')) {
    recipes.push({
      id: 'android-release',
      label: 'Android Release APK/AAB',
      target: 'android',
      command: isWindows ? path.join(root, 'gradlew.bat') : path.join(root, 'gradlew'),
      args: ['assembleRelease'],
      cwd: root
    });
  }

  if (await exists(root, 'Cargo.toml')) recipes.push({ id: 'cargo-release', label: 'Rust release build', target: 'generic', command: 'cargo', args: ['build', '--release'], cwd: root });

  if (await exists(root, 'CMakeLists.txt')) {
    const buildDir = path.join(root, 'build');
    recipes.push({ id: 'cmake-configure', label: 'CMake configure', target: 'generic', command: 'cmake', args: ['-S', root, '-B', buildDir], cwd: root });
    recipes.push({ id: 'cmake-build', label: 'CMake release build', target: 'generic', command: 'cmake', args: ['--build', buildDir, '--config', 'Release'], cwd: root });
  }

  if (await exists(root, 'pubspec.yaml')) {
    recipes.push({ id: 'flutter-windows', label: 'Flutter Windows', target: 'windows', command: 'flutter', args: ['build', 'windows'], cwd: root });
    recipes.push({ id: 'flutter-linux', label: 'Flutter Linux', target: 'linux', command: 'flutter', args: ['build', 'linux'], cwd: root });
    recipes.push({ id: 'flutter-macos', label: 'Flutter macOS', target: 'macos', command: 'flutter', args: ['build', 'macos'], cwd: root });
    recipes.push({ id: 'flutter-android', label: 'Flutter Android APK', target: 'android', command: 'flutter', args: ['build', 'apk', '--release'], cwd: root });
  }

  return recipes;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function inferBuildStage(text: string, fallback: string): string {
  const value = text.toLowerCase();
  if (/download|resolve|restore|install|dependency/.test(value)) return 'Resolving dependencies';
  if (/configure|configuration|generating/.test(value)) return 'Configuring';
  if (/compile|compiling|javac|kotlinc|typescript|tsc/.test(value)) return 'Compiling';
  if (/link|linking|ld\b/.test(value)) return 'Linking';
  if (/test|testing|pytest|jest|mocha/.test(value)) return 'Running tests';
  if (/sign|signing|codesign/.test(value)) return 'Signing';
  if (/package|packaging|bundle|bundling|assemble|archive/.test(value)) return 'Packaging';
  if (/verify|validation|validate/.test(value)) return 'Verifying';
  return fallback;
}

async function averageDuration(context: vscode.ExtensionContext, recipeId: string): Promise<number | undefined> {
  const values = context.globalState.get<number[]>(`codeforge.build.history.${recipeId}`, []);
  return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : undefined;
}

async function rememberDuration(context: vscode.ExtensionContext, recipeId: string, duration: number): Promise<void> {
  const values = context.globalState.get<number[]>(`codeforge.build.history.${recipeId}`, []);
  await context.globalState.update(`codeforge.build.history.${recipeId}`, [...values, duration].slice(-10));
}

function extractDiagnostics(log: string): string[] {
  const diagnostic = /(?:\berror\b|\bwarning\b|\bfatal\b|\bfailed\b|\bexception\b|\bundefined reference\b)/i;
  return [...new Set(sanitizeDiagnosticText(log).split(/\r?\n/).map(line => line.trim()).filter(line => line && diagnostic.test(line)))].slice(-60);
}

function buildHistory(context: vscode.ExtensionContext): BuildHistoryEntry[] {
  return context.workspaceState.get<BuildHistoryEntry[]>(BUILD_HISTORY_KEY, []);
}

async function rememberBuild(context: vscode.ExtensionContext, result: BuildResult): Promise<void> {
  const limit = Math.max(5, Math.min(250, vscode.workspace.getConfiguration('codeforge.build').get<number>('historyLimit', 50)));
  const entry: BuildHistoryEntry = {
    id: `${result.startedAt}-${result.recipe.id}`,
    recipe: {
      id: result.recipe.id,
      label: result.recipe.label,
      target: result.recipe.target,
      command: result.recipe.command,
      args: result.recipe.args
    },
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    exitCode: result.exitCode,
    stages: result.stages,
    diagnostics: extractDiagnostics(result.log),
    artifacts: result.artifacts
  };
  await context.workspaceState.update(BUILD_HISTORY_KEY, [entry, ...buildHistory(context)].slice(0, limit));
}

async function showBuildHistory(context: vscode.ExtensionContext): Promise<void> {
  const history = buildHistory(context);
  if (!history.length) {
    void vscode.window.showInformationMessage('CodeForge Build Center has no history for this workspace yet.');
    return;
  }
  const selected = await vscode.window.showQuickPick(history.map(entry => ({
    label: `${entry.exitCode === 0 ? '$(pass-filled)' : '$(error)'} ${entry.recipe.label}`,
    description: `${entry.recipe.target} · ${formatDuration(entry.finishedAt - entry.startedAt)}`,
    detail: `${new Date(entry.startedAt).toLocaleString()} · ${entry.artifacts.length} artifact${entry.artifacts.length === 1 ? '' : 's'} · ${entry.diagnostics.length} diagnostic${entry.diagnostics.length === 1 ? '' : 's'}`,
    entry
  })), { title: 'CodeForge Build History', placeHolder: 'Select a build to inspect', matchOnDescription: true, matchOnDetail: true });
  if (!selected) return;

  const entry = selected.entry;
  const artifactLines = entry.artifacts.length
    ? entry.artifacts.map(artifact => `- [${artifact.relativePath}](${vscode.Uri.file(artifact.filePath).toString()}) — ${artifact.kind}, ${formatArtifactSize(artifact.size)}`)
    : ['- No fresh installer or application artifacts detected.'];
  const diagnosticLines = entry.diagnostics.length
    ? entry.diagnostics.map(line => `- \`${line.replace(/`/g, '\\`')}\``)
    : ['- No warning or error diagnostics captured.'];
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      `# ${entry.exitCode === 0 ? 'Successful build' : 'Failed build'} · ${entry.recipe.label}`,
      '',
      `- **Target:** ${entry.recipe.target}`,
      `- **Started:** ${new Date(entry.startedAt).toLocaleString()}`,
      `- **Duration:** ${formatDuration(entry.finishedAt - entry.startedAt)}`,
      `- **Exit code:** ${entry.exitCode ?? 'unknown'}`,
      `- **Command:** \`${sanitizeDiagnosticText([entry.recipe.command, ...entry.recipe.args].join(' ')).replace(/`/g, '\\`')}\``,
      '',
      '## Stages',
      '',
      ...(entry.stages.length ? entry.stages.map(stage => `- ${stage}`) : ['- No stages inferred.']),
      '',
      '## Artifacts',
      '',
      ...artifactLines,
      '',
      '## Diagnostics',
      '',
      ...diagnosticLines,
      '',
      '> Build Center stores only redacted diagnostic lines, not the raw build log. Full output remains in the current CodeForge Build output channel.'
    ].join('\n')
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function clearBuildHistory(context: vscode.ExtensionContext): Promise<void> {
  if (!buildHistory(context).length) return;
  const confirmation = await vscode.window.showWarningMessage('Clear detailed CodeForge build history for this workspace?', { modal: true }, 'Clear history');
  if (confirmation === 'Clear history') await context.workspaceState.update(BUILD_HISTORY_KEY, undefined);
}

function buildStatus(recipe: BuildRecipe, stage: string, startedAt: number, expected?: number): string {
  const elapsed = Date.now() - startedAt;
  const eta = expected === undefined ? undefined : Math.max(0, expected - elapsed);
  return eta === undefined
    ? `${recipe.label} · ${stage} · elapsed ${formatDuration(elapsed)} · ETA learning…`
    : `${recipe.label} · ${stage} · elapsed ${formatDuration(elapsed)} · ETA ~${formatDuration(eta)}`;
}

async function runBuild(context: vscode.ExtensionContext, recipe: BuildRecipe, output: vscode.OutputChannel, operations: OperationState, mcp: MCPPermissionBroker): Promise<void> {
  if (activeBuild || operations.isRunning('build')) {
    void vscode.window.showWarningMessage('A CodeForge build is already running.');
    return;
  }

  output.clear();
  output.show(true);
  const startedAt = Date.now();
  const expected = await averageDuration(context, recipe.id);
  let log = '';
  let stage = 'Starting build';
  const stages = [stage];

  output.appendLine('CodeForge Build Center');
  output.appendLine(`Target: ${recipe.target}`);
  output.appendLine(`Recipe: ${recipe.label}`);
  output.appendLine(`Command: ${recipe.command} ${recipe.args.join(' ')}`);
  output.appendLine(`Workspace: ${recipe.cwd}`);
  output.appendLine('');

  await operations.begin('build', buildStatus(recipe, stage, startedAt, expected), () => activeBuild?.kill());
  let result: BuildResult;
  try {
    result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `CodeForge: ${recipe.label}`,
      cancellable: true
    }, async (progress, token) => new Promise<BuildResult>(resolve => {
      let settled = false;
      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        activeBuild = undefined;
        resolve({ recipe, startedAt, finishedAt: Date.now(), exitCode, log, stages, artifacts: [] });
      };

      activeBuild = spawn(recipe.command, recipe.args, {
        cwd: recipe.cwd,
        env: process.env,
        shell: false,
        windowsHide: true
      });

      const timer = setInterval(() => {
        const status = buildStatus(recipe, stage, startedAt, expected);
        operations.update('build', status);
        progress.report({ message: status.replace(`${recipe.label} · `, '') });
      }, 1000);

      token.onCancellationRequested(() => {
        if (!activeBuild) return;
        stage = 'Cancelling';
        operations.update('build', buildStatus(recipe, stage, startedAt, expected));
        activeBuild.kill();
        output.appendLine('\nBuild cancellation requested by user.');
      });

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        log += text;
        stage = inferBuildStage(text, stage);
        if (stages[stages.length - 1] !== stage) stages.push(stage);
        operations.update('build', buildStatus(recipe, stage, startedAt, expected));
        output.append(text);
      };

      activeBuild.stdout.on('data', onData);
      activeBuild.stderr.on('data', onData);
      activeBuild.on('error', error => {
        log += `\n${error.stack ?? error.message}\n`;
        output.appendLine(`\nFailed to start build: ${error.message}`);
        finish(-1);
      });
      activeBuild.on('close', code => finish(code));
    }));
  } finally {
    await operations.end('build');
  }

  lastBuild = result;
  const duration = result.finishedAt - result.startedAt;
  await rememberDuration(context, recipe.id, duration);
  if (result.exitCode === 0) {
    try {
      result.artifacts = await findFreshBuildArtifacts(recipe.cwd, result.startedAt);
    } catch {
      result.artifacts = [];
    }
  }
  await rememberBuild(context, result);
  output.appendLine('');
  output.appendLine(result.exitCode === 0
    ? `BUILD SUCCESSFUL · ${formatDuration(duration)}`
    : `BUILD FAILED (${result.exitCode ?? 'unknown'}) · ${formatDuration(duration)}`);

  if (result.exitCode === 0) {
    void vscode.window.showInformationMessage(`CodeForge build succeeded in ${formatDuration(duration)}.`, 'Open Build Output').then(action => {
      if (action === 'Open Build Output') output.show(true);
    });
  } else {
    await handleBuildFailure(result, mcp);
  }
}

async function handleBuildFailure(result: BuildResult, mcp: MCPPermissionBroker): Promise<void> {
  try {
    const routed = await mcp.routeBuildFailure({
      target: result.recipe.target,
      recipe: result.recipe.label,
      command: result.recipe.command,
      args: result.recipe.args,
      exitCode: result.exitCode,
      log: result.log
    });
    if (routed) void vscode.window.showInformationMessage('CodeForge securely routed sanitized build diagnostics to MCP.');
  } catch (error) {
    void vscode.window.showWarningMessage(`CodeForge MCP routing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const autoAnalyze = vscode.workspace.getConfiguration('codeforge.build').get<boolean>('autoAnalyzeFailures', true);
  if (autoAnalyze) {
    await vscode.commands.executeCommand('codeforge.analyzeLastBuild');
    return;
  }
  const action = await vscode.window.showErrorMessage(`Build failed: ${result.recipe.label}`, 'Ask AI why', 'Open Output');
  if (action === 'Ask AI why') await vscode.commands.executeCommand('codeforge.analyzeLastBuild');
}

async function openBuildCenter(context: vscode.ExtensionContext, output: vscode.OutputChannel, timeline: SafetyTimeline, operations: OperationState, mcp: MCPPermissionBroker): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage('Open a project folder before using CodeForge Build Center.');
    return;
  }

  const recipes = await detectBuildRecipes(root);
  const retainedBuilds = buildHistory(context).length;
  const action = await vscode.window.showQuickPick([
    { label: '$(play) Run detected build', id: 'run', description: `${recipes.length} target${recipes.length === 1 ? '' : 's'} available` },
    { label: '$(history) View build history', id: 'history', description: `${retainedBuilds} retained build${retainedBuilds === 1 ? '' : 's'}` },
    { label: '$(clear-all) Clear build history', id: 'clear', description: retainedBuilds ? 'Remove retained diagnostics and artifact records' : 'History is empty' }
  ], { title: 'CodeForge Build Center', placeHolder: 'Build, inspect diagnostics, and open artifacts' });
  if (!action) return;
  if (action.id === 'history') return showBuildHistory(context);
  if (action.id === 'clear') return clearBuildHistory(context);
  if (!recipes.length) {
    void vscode.window.showWarningMessage('CodeForge did not detect a supported build system in this workspace.');
    return;
  }

  const items = await Promise.all(recipes.map(async recipe => {
    const avg = await averageDuration(context, recipe.id);
    return {
      label: recipe.label,
      description: recipe.target,
      detail: avg ? `Average previous build: ${formatDuration(avg)}` : 'No timing history yet',
      recipe
    };
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'CodeForge Build Center',
    placeHolder: 'Choose a detected build target'
  });
  if (!selected) return;

  if (vscode.workspace.getConfiguration('codeforge.timeline').get<boolean>('autoCheckpointBeforeBuild', true)) {
    try {
      await timeline.createCheckpoint(`Before build: ${selected.recipe.label}`, true);
    } catch (error) {
      const proceed = await vscode.window.showWarningMessage(
        `CodeForge could not create the pre-build checkpoint: ${error instanceof Error ? error.message : String(error)}`,
        { modal: true },
        'Build without checkpoint'
      );
      if (proceed !== 'Build without checkpoint') return;
    }
  }

  await runBuild(context, selected.recipe, output, operations, mcp);
}

async function showAIAnalysis(ai: AIService, result: BuildResult, operations: OperationState): Promise<void> {
  const status = `Analyzing failed build: ${result.recipe.label}`;
  const analysis = await operations.run('ai', status, async () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'CodeForge AI: analyzing failed build…',
    cancellable: false
  }, async () => ai.analyzeBuildFailure({
    target: result.recipe.target,
    recipe: result.recipe.label,
    command: result.recipe.command,
    args: result.recipe.args,
    exitCode: result.exitCode,
    log: sanitizeDiagnosticText(result.log)
  })));
  lastAnalysis = analysis;

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: [
      '# CodeForge Build Doctor',
      '',
      `**Provider:** ${analysis.provider}`,
      `**Model:** ${analysis.model}`,
      `**Target:** ${result.recipe.target}`,
      `**Recipe:** ${result.recipe.label}`,
      `**Exit code:** ${result.exitCode ?? 'unknown'}`,
      '',
      '## Diagnosis',
      '',
      analysis.content,
      '',
      '---',
      '',
      '> CodeForge sanitized build output before sending it to the model. Provider credentials are stored separately and are never included in the prompt.'
    ].join('\n')
  });
  await vscode.window.showTextDocument(document, { preview: false });
  if (extractUnifiedDiff(analysis.content)) {
    const action = await vscode.window.showInformationMessage('CodeForge AI included a patch. Review it before applying.', 'Review AI patch');
    if (action === 'Review AI patch') await vscode.commands.executeCommand('codeforge.applyLastAIFix');
  }
}

function extractUnifiedDiff(content: string): string | undefined {
  const fenced = /```diff\s*\r?\n([\s\S]*?)```/i.exec(content)?.[1];
  const diff = (fenced ?? content.slice(content.indexOf('diff --git '))).trim();
  if (!diff.startsWith('diff --git ')) return undefined;
  if (/^(?:---|\+\+\+)\s+(?:[A-Za-z]:[\\/]|\/|(?:a\/|b\/)?\.\.\/)/m.test(diff)) return undefined;
  if (/^GIT binary patch$/m.test(diff)) return undefined;
  return `${diff}\n`;
}

function runProcess(command: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => output += chunk.toString());
    child.stderr.on('data', chunk => output += chunk.toString());
    child.on('error', error => resolve({ code: -1, output: error.message }));
    child.on('close', code => resolve({ code, output }));
  });
}

async function reviewAndApplyLastAIFix(context: vscode.ExtensionContext, timeline: SafetyTimeline, output: vscode.OutputChannel, operations: OperationState, mcp: MCPPermissionBroker): Promise<void> {
  const root = workspaceRoot();
  const build = lastBuild;
  const patch = lastAnalysis && extractUnifiedDiff(lastAnalysis.content);
  if (!root || !build || !patch) {
    void vscode.window.showInformationMessage('There is no validated AI patch available to review.');
    return;
  }

  const document = await vscode.workspace.openTextDocument({ language: 'diff', content: patch });
  await vscode.window.showTextDocument(document, { preview: false });

  const storage = context.storageUri ?? context.globalStorageUri;
  await vscode.workspace.fs.createDirectory(storage);
  const patchUri = vscode.Uri.joinPath(storage, `ai-fix-${Date.now()}.patch`);
  await vscode.workspace.fs.writeFile(patchUri, Buffer.from(patch, 'utf8'));
  try {
    const checked = await runProcess('git', ['apply', '--check', '--whitespace=error-all', patchUri.fsPath], root);
    if (checked.code !== 0) {
      void vscode.window.showErrorMessage(`CodeForge rejected the AI patch: ${sanitizeDiagnosticText(checked.output).slice(-1000)}`);
      return;
    }

    const approval = await vscode.window.showWarningMessage(
      `Apply the reviewed AI patch for “${build.recipe.label}”? CodeForge will create a Safety Timeline checkpoint first.`,
      { modal: true, detail: 'The patch passed git apply --check. It will modify working-tree files but will not stage or commit them.' },
      'Create checkpoint and apply'
    );
    if (approval !== 'Create checkpoint and apply') return;

    await timeline.createCheckpoint(`Before AI fix: ${build.recipe.label}`, true);
    const applied = await runProcess('git', ['apply', '--whitespace=nowarn', patchUri.fsPath], root);
    if (applied.code !== 0) throw new Error(`git apply failed after validation: ${sanitizeDiagnosticText(applied.output).slice(-1000)}`);

    const action = await vscode.window.showInformationMessage('CodeForge applied the AI patch after creating a recoverable checkpoint.', 'Rerun build');
    if (action === 'Rerun build') await runBuild(context, build.recipe, output, operations, mcp);
  } finally {
    await vscode.workspace.fs.delete(patchUri, { useTrash: false });
  }
}

async function openAIControl(ai: AIService, operations: OperationState): Promise<void> {
  const selection = await vscode.window.showQuickPick([
    { label: '$(plug) Test AI connection', id: 'test' },
    { label: '$(settings-gear) Open AI settings', id: 'settings' },
    { label: '$(key) Set/replace Bionic API key', id: 'setKey' },
    { label: '$(trash) Clear Bionic API key', id: 'clearKey' }
  ], { title: 'CodeForge AI', placeHolder: 'Manage Ollama / Bionic AI' });

  if (!selection) return;
  if (selection.id === 'settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.ai');
    return;
  }
  if (selection.id === 'setKey') {
    const changed = await ai.setBionicApiKey();
    if (changed) void vscode.window.showInformationMessage('CodeForge securely updated the Bionic API key.');
    return;
  }
  if (selection.id === 'clearKey') {
    await ai.clearBionicApiKey();
    void vscode.window.showInformationMessage('CodeForge cleared the stored Bionic API key.');
    return;
  }

  await operations.run('ai', 'Testing local AI connection', async () => {
    await vscode.commands.executeCommand('codeforge.testAIConnection');
  });
}

async function chooseRepository(github: GitHubService, operations: OperationState, title: string): Promise<GitHubRepository | undefined> {
  const repositories = await operations.run('git', 'Loading GitHub repositories', async () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'CodeForge: loading GitHub repositories…',
    cancellable: false
  }, () => github.listRepositories()));

  const selection = await vscode.window.showQuickPick(repositories.map(repository => ({
    label: repository.full_name,
    description: repository.private ? 'Private' : 'Public',
    detail: repository.description ?? repository.html_url,
    repository
  })), { title, placeHolder: 'Choose a GitHub repository', matchOnDescription: true, matchOnDetail: true });
  return selection?.repository;
}

async function createGitHubRepository(github: GitHubService, operations: OperationState): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Create GitHub Repository',
    prompt: 'Repository name',
    validateInput: value => /^[A-Za-z0-9._-]+$/.test(value) ? undefined : 'Use letters, numbers, dot, underscore or hyphen.'
  });
  if (!name) return;

  const visibility = await vscode.window.showQuickPick([
    { label: 'Private', private: true },
    { label: 'Public', private: false }
  ], { title: 'Repository visibility' });
  if (!visibility) return;

  const description = await vscode.window.showInputBox({ title: 'Repository description', prompt: 'Optional description' });
  const repository = await operations.run('git', `Creating GitHub repository: ${name}`, async () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Creating ${name} on GitHub…`,
    cancellable: false
  }, () => github.createRepository(name, visibility.private, description)));

  const action = await vscode.window.showInformationMessage(`Created ${repository.full_name}.`, 'Open on GitHub', 'Clone');
  if (action === 'Open on GitHub') await vscode.env.openExternal(vscode.Uri.parse(repository.html_url));
  if (action === 'Clone') await operations.run('git', `Cloning ${repository.full_name}`, async () => vscode.commands.executeCommand('git.clone', repository.clone_url));
}

async function readGitHubFile(github: GitHubService, operations: OperationState): Promise<void> {
  const repository = await chooseRepository(github, operations, 'Read file from GitHub');
  if (!repository) return;

  const filePath = await vscode.window.showInputBox({ title: repository.full_name, prompt: 'Repository file path, for example src/main.ts' });
  if (!filePath) return;
  const ref = await vscode.window.showInputBox({ title: 'Branch / tag / commit', prompt: `Optional ref (default: ${repository.default_branch})`, value: repository.default_branch });

  const file = await operations.run('git', `Reading ${repository.full_name}/${filePath}`, async () => vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Reading ${filePath} from GitHub…`,
    cancellable: false
  }, () => github.readRepositoryFile(repository.full_name, filePath, ref || undefined)));

  const document = await vscode.workspace.openTextDocument({ content: file.text });
  await vscode.window.showTextDocument(document, { preview: false });
}

async function runGitCommand(operations: OperationState, command: string, label: string): Promise<void> {
  await operations.run('git', label, async () => {
    await vscode.commands.executeCommand(command);
  });
}

async function openGitHubControl(github: GitHubService, operations: OperationState): Promise<void> {
  const signedIn = await github.isSignedIn();
  const action = await vscode.window.showQuickPick([
    { label: signedIn ? '$(account) GitHub account status' : '$(sign-in) Sign in with GitHub', id: 'account' },
    { label: '$(new-folder) Create GitHub repository', id: 'create' },
    { label: '$(repo) Browse repositories', id: 'browse' },
    { label: '$(repo-clone) Clone repository', id: 'clone' },
    { label: '$(file-code) Read file from GitHub', id: 'read' },
    { label: '$(cloud-upload) Push current repository', id: 'push' },
    { label: '$(cloud-download) Pull current repository', id: 'pull' },
    { label: '$(sync) Sync current repository', id: 'sync' },
    { label: '$(settings-gear) GitHub settings', id: 'settings' },
    ...(signedIn ? [{ label: '$(sign-out) Sign out of GitHub', id: 'signout' }] : [])
  ], { title: 'CodeForge GitHub', placeHolder: signedIn ? 'GitHub connected' : 'GitHub not connected' });

  if (!action) return;
  switch (action.id) {
    case 'account': {
      const user = signedIn
        ? await operations.run('git', 'Loading GitHub account', () => github.getCurrentUser())
        : await operations.run('git', 'Waiting for GitHub sign-in', () => github.signIn());
      if (user) void vscode.window.showInformationMessage(`CodeForge is connected to GitHub as ${user.login}.`);
      break;
    }
    case 'create':
      await createGitHubRepository(github, operations);
      break;
    case 'browse': {
      const repository = await chooseRepository(github, operations, 'CodeForge GitHub Repositories');
      if (repository) await vscode.env.openExternal(vscode.Uri.parse(repository.html_url));
      break;
    }
    case 'clone': {
      const repository = await chooseRepository(github, operations, 'Clone from GitHub');
      if (repository) await operations.run('git', `Cloning ${repository.full_name}`, async () => vscode.commands.executeCommand('git.clone', repository.clone_url));
      break;
    }
    case 'read':
      await readGitHubFile(github, operations);
      break;
    case 'push':
      await runGitCommand(operations, 'git.push', 'Pushing repository to GitHub');
      break;
    case 'pull':
      await runGitCommand(operations, 'git.pull', 'Pulling repository from GitHub');
      break;
    case 'sync':
      await runGitCommand(operations, 'git.sync', 'Synchronizing repository with GitHub');
      break;
    case 'settings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.github');
      break;
    case 'signout':
      await github.signOut();
      void vscode.window.showInformationMessage('CodeForge signed out of GitHub and removed its stored token.');
      break;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('CodeForge Build');
  const ai = new AIService(context);
  const github = new GitHubService(context);
  const operations = new OperationState();
  const timeline = new SafetyTimeline(context);
  const mcp = new MCPPermissionBroker(context);
  context.subscriptions.push(output, mcp);
  await operations.initialize();

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openBuildCenter', async () => openBuildCenter(context, output, timeline, operations, mcp)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.build.showHistory', async () => showBuildHistory(context)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.build.clearHistory', async () => clearBuildHistory(context)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.cancelBuild', () => activeBuild?.kill()));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.cancelActiveOperations', async () => operations.cancelAll()));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.analyzeLastBuild', async () => {
    if (!lastBuild || lastBuild.exitCode === 0) {
      void vscode.window.showInformationMessage('There is no failed build to analyze.');
      return;
    }
    try {
      await showAIAnalysis(ai, lastBuild, operations);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showErrorMessage(`CodeForge AI analysis failed: ${message}`, 'Test AI connection', 'Open AI settings');
      if (action === 'Test AI connection') await vscode.commands.executeCommand('codeforge.testAIConnection');
      if (action === 'Open AI settings') await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.ai');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.applyLastAIFix', async () => {
    try {
      await reviewAndApplyLastAIFix(context, timeline, output, operations, mcp);
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeForge could not apply the AI fix: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.testAIConnection', async () => {
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'CodeForge: detecting local AI…',
        cancellable: false
      }, () => ai.testConnection());
      const preview = result.models.slice(0, 5).join(', ') || 'none';
      void vscode.window.showInformationMessage(`CodeForge connected to ${result.provider}. Selected: ${result.selectedModel}. Models: ${preview}${result.models.length > 5 ? '…' : ''}`);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.setBionicApiKey', async () => {
    const changed = await ai.setBionicApiKey();
    if (changed) void vscode.window.showInformationMessage('Bionic API key stored securely.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.clearBionicApiKey', async () => {
    await ai.clearBionicApiKey();
    void vscode.window.showInformationMessage('Bionic API key cleared.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openAI', async () => openAIControl(ai, operations)));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openMCP', async () => openMCPControlCenter(mcp)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.mcp.manage', openMCPManager));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.mcp.addServer', addMCPServer));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.mcp.installed', showInstalledMCPServers));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.mcp.resources', browseMCPResources));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.mcp.openConfig', openMCPConfiguration));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openGitHub', async () => {
    try {
      await openGitHubControl(github, operations);
    } catch (error) {
      void vscode.window.showErrorMessage(`CodeForge GitHub: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.signIn', async () => operations.run('git', 'Waiting for GitHub sign-in', () => github.signIn())));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.createRepository', async () => createGitHubRepository(github, operations)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.readFile', async () => readGitHubFile(github, operations)));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.push', async () => runGitCommand(operations, 'git.push', 'Pushing repository to GitHub')));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.pull', async () => runGitCommand(operations, 'git.pull', 'Pulling repository from GitHub')));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.github.sync', async () => runGitCommand(operations, 'git.sync', 'Synchronizing repository with GitHub')));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.timeline.createCheckpoint', async () => {
    const reason = await vscode.window.showInputBox({ title: 'CodeForge Safety Timeline', prompt: 'Checkpoint description', value: 'Manual checkpoint' });
    if (reason) await timeline.createCheckpoint(reason);
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.timeline.show', async () => timeline.show()));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.timeline.restoreLatest', async () => timeline.restoreLatest()));
  context.subscriptions.push(vscode.commands.registerCommand('codeforge.timeline.createAIBranch', async () => {
    const task = await vscode.window.showInputBox({ title: 'CodeForge AI Branch', prompt: 'Describe the AI task this isolated branch will contain' });
    if (task) await timeline.createAIBranch(task);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.status', () => {
    const root = workspaceRoot();
    void vscode.window.showInformationMessage(`CodeForge platform active${root ? ` · ${path.basename(root)}` : ''}.`);
  }));
}

export function deactivate(): void {
  activeBuild?.kill();
  activeBuild = undefined;
}
