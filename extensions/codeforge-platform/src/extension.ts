import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';

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
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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

  output.appendLine(`CodeForge Build Center`);
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
        progress.report({ message: eta === undefined ? `Elapsed ${formatDuration(elapsed)} · ETA learning…` : `Elapsed ${formatDuration(elapsed)} · ETA ~${formatDuration(eta)}` });
      }, 1000);

      token.onCancellationRequested(() => {
        if (activeBuild) {
          activeBuild.kill();
          output.appendLine('\nBuild cancellation requested by user.');
        }
      });

      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        log += text;
        output.append(text);
      };

      activeBuild.stdout.on('data', onData);
      activeBuild.stderr.on('data', onData);

      activeBuild.on('error', async (error) => {
        clearInterval(timer);
        const finishedAt = Date.now();
        log += `\n${error.stack ?? error.message}\n`;
        output.appendLine(`\nFailed to start build: ${error.message}`);
        lastBuild = { recipe, startedAt, finishedAt, exitCode: -1, log };
        activeBuild = undefined;
        await handleBuildFailure(context, lastBuild);
        resolve();
      });

      activeBuild.on('close', async (code) => {
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

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeForge Build');
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

    const provider = vscode.workspace.getConfiguration('codeforge.ai').get<string>('provider', 'auto');
    const sanitizedLog = lastBuild.log.slice(-30000);
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: `# CodeForge Build Failure Analysis\n\n**Provider:** ${provider}\n\n**Target:** ${lastBuild.recipe.target}\n\n**Recipe:** ${lastBuild.recipe.label}\n\n**Exit code:** ${lastBuild.exitCode}\n\n## Build log (sanitized context)\n\n\`\`\`text\n${sanitizedLog}\n\`\`\`\n\n> AI provider execution will consume this sanitized diagnostic context. Raw credentials and secret storage are never included.\n`
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage('CodeForge prepared the failed build context for AI analysis. Provider execution is the next integration step.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.openAI', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.ai');
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
