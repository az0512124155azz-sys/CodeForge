import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { AIService, sanitizeDiagnosticText } from './ai';

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
}

let activeBuild: ChildProcessWithoutNullStreams | undefined;
let lastBuild: BuildResult | undefined;

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
    if (pkg?.scripts?.build) {
      recipes.push({ id: 'npm-build', label: 'npm build', target: 'generic', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build'], cwd: root });
    }
    if (pkg?.scripts?.['build:win']) {
      recipes.push({ id: 'npm-build-win', label: 'Windows build', target: 'windows', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:win'], cwd: root });
    }
    if (pkg?.scripts?.['build:linux']) {
      recipes.push({ id: 'npm-build-linux', label: 'Linux build', target: 'linux', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:linux'], cwd: root });
    }
    if (pkg?.scripts?.['build:mac']) {
      recipes.push({ id: 'npm-build-mac', label: 'macOS build', target: 'macos', command: isWindows ? 'npm.cmd' : 'npm', args: ['run', 'build:mac'], cwd: root });
    }
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

  if (await exists(root, 'Cargo.toml')) {
    recipes.push({ id: 'cargo-release', label: 'Rust release build', target: 'generic', command: 'cargo', args: ['build', '--release'], cwd: root });
  }

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
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
  if (!values.length) {
    return undefined;
  }
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

async function rememberDuration(context: vscode.ExtensionContext, recipeId: string, duration: number): Promise<void> {
  const values = context.globalState.get<number[]>(`codeforge.build.history.${recipeId}`, []);
  const next = [...values, duration].slice(-10);
  await context.globalState.update(`codeforge.build.history.${recipeId}`, next);
}

async function runBuild(context: vscode.ExtensionContext, recipe: BuildRecipe, output: vscode.OutputChannel): Promise<void> {
  if (activeBuild) {
    void vscode.window.showWarningMessage('A CodeForge build is already running.');
    return;
  }

  output.clear();
  output.show(true);
  const startedAt = Date.now();
  const expected = await averageDuration(context, recipe.id);
  let log = '';
  let stage = 'Starting build';
  let settled = false;

  output.appendLine('CodeForge Build Center');
  output.appendLine(`Target: ${recipe.target}`);
  output.appendLine(`Recipe: ${recipe.label}`);
  output.appendLine(`Command: ${recipe.command} ${recipe.args.join(' ')}`);
  output.appendLine(`Workspace: ${recipe.cwd}`);
  output.appendLine('');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `CodeForge: ${recipe.label}`,
    cancellable: true
  }, async (progress, token) => {
    return new Promise<void>((resolve) => {
      activeBuild = spawn(recipe.command, recipe.args, {
        cwd: recipe.cwd,
        env: process.env,
        shell: false,
        windowsHide: true
      });

      const timer = setInterval(() => {
        const elapsed = Date.now() - startedAt;
        const eta = expected ? Math.max(0, expected - elapsed) : undefined;
        progress.report({
          message: eta === undefined
            ? `${stage} · Elapsed ${formatDuration(elapsed)} · ETA learning…`
            : `${stage} · Elapsed ${formatDuration(elapsed)} · ETA ~${formatDuration(eta)}`
        });
      }, 1000);

      token.onCancellationRequested(() => {
        if (activeBuild) {
          stage = 'Cancelling';
          activeBuild.kill();
          output.appendLine('\nBuild cancellation requested by user.');
        }
      });

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        log += text;
        stage = inferBuildStage(text, stage);
        output.append(text);
      };

      activeBuild.stdout.on('data', onData);
      activeBuild.stderr.on('data', onData);

      activeBuild.on('error', async error => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        const finishedAt = Date.now();
        log += `\n${error.stack ?? error.message}\n`;
        output.appendLine(`\nFailed to start build: ${error.message}`);
        lastBuild = { recipe, startedAt, finishedAt, exitCode: -1, log };
        activeBuild = undefined;
        await handleBuildFailure(context, lastBuild);
        resolve();
      });

      activeBuild.on('close', async code => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        const finishedAt = Date.now();
        const duration = finishedAt - startedAt;
        await rememberDuration(context, recipe.id, duration);
        lastBuild = { recipe, startedAt, finishedAt, exitCode: code, log };
        activeBuild = undefined;

        output.appendLine('');
        output.appendLine(code === 0 ? `BUILD SUCCESSFUL · ${formatDuration(duration)}` : `BUILD FAILED (${code ?? 'unknown'}) · ${formatDuration(duration)}`);

        if (code === 0) {
          void vscode.window.showInformationMessage(`CodeForge build succeeded in ${formatDuration(duration)}.`, 'Open Build Output').then(action => {
            if (action === 'Open Build Output') {
              output.show(true);
            }
          });
        } else {
          await handleBuildFailure(context, lastBuild);
        }
        resolve();
      });
    });
  });
}

async function handleBuildFailure(context: vscode.ExtensionContext, result: BuildResult): Promise<void> {
  const autoAnalyze = vscode.workspace.getConfiguration('codeforge.build').get<boolean>('autoAnalyzeFailures', true);
  if (autoAnalyze) {
    await vscode.commands.executeCommand('codeforge.analyzeLastBuild');
    return;
  }

  const action = await vscode.window.showErrorMessage(`Build failed: ${result.recipe.label}`, 'Ask AI why', 'Open Output');
  if (action === 'Ask AI why') {
    await vscode.commands.executeCommand('codeforge.analyzeLastBuild');
  }
}

async function openBuildCenter(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage('Open a project folder before using CodeForge Build Center.');
    return;
  }

  const recipes = await detectBuildRecipes(root);
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
  if (selected) {
    await runBuild(context, selected.recipe, output);
  }
}

async function showAIAnalysis(ai: AIService, result: BuildResult): Promise<void> {
  const analysis = await vscode.window.withProgress({
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
  }));

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
}

async function openAIControl(ai: AIService): Promise<void> {
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
  await vscode.commands.executeCommand('codeforge.testAIConnection');
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeForge Build');
  const ai = new AIService(context);
  context.subscriptions.push(output);

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openBuildCenter', async () => {
    await openBuildCenter(context, output);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.cancelBuild', () => {
    if (!activeBuild) {
      void vscode.window.showInformationMessage('No CodeForge build is currently running.');
      return;
    }
    activeBuild.kill();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.analyzeLastBuild', async () => {
    if (!lastBuild || lastBuild.exitCode === 0) {
      void vscode.window.showInformationMessage('There is no failed build to analyze.');
      return;
    }

    try {
      await showAIAnalysis(ai, lastBuild);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showErrorMessage(`CodeForge AI analysis failed: ${message}`, 'Test AI connection', 'Open AI settings');
      if (action === 'Test AI connection') {
        await vscode.commands.executeCommand('codeforge.testAIConnection');
      } else if (action === 'Open AI settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.ai');
      }
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.testAIConnection', async () => {
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'CodeForge: detecting local AI…',
        cancellable: false
      }, async () => ai.testConnection());
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

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openAI', async () => {
    await openAIControl(ai);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openMCP', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.mcp');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openGitHub', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.github');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.status', () => {
    const root = workspaceRoot();
    void vscode.window.showInformationMessage(`CodeForge platform active${root ? ` · ${path.basename(root)}` : ''}.`);
  }));
}

export function deactivate(): void {
  if (activeBuild) {
    activeBuild.kill();
    activeBuild = undefined;
  }
}
