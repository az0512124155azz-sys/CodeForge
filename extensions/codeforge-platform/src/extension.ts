import * as vscode from 'vscode';

function registerCommand(context: vscode.ExtensionContext, command: string, title: string, detail: string): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    const action = await vscode.window.showInformationMessage(title, { modal: false, detail }, 'Open Settings');
    if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge');
    }
  }));
}

export function activate(context: vscode.ExtensionContext): void {
  registerCommand(
    context,
    'codeforge.openBuildCenter',
    'CodeForge Build Center',
    'The Build Center shell is active. Windows, Linux, macOS and Android build orchestration will be added here.'
  );

  registerCommand(
    context,
    'codeforge.openAI',
    'CodeForge AI',
    'CodeForge AI provider routing is active with Auto, Ollama and Bionic/OpenAI-compatible configuration.'
  );

  registerCommand(
    context,
    'codeforge.openMCP',
    'CodeForge MCP',
    'The MCP integration shell is active. Server management, permissions, tools, resources and prompts will be added here.'
  );

  registerCommand(
    context,
    'codeforge.openGitHub',
    'CodeForge GitHub',
    'The GitHub integration shell is active. OAuth login, repository browsing, branches and publishing will be added here.'
  );

  context.subscriptions.push(vscode.commands.registerCommand('codeforge.status', () => {
    vscode.window.showInformationMessage('CodeForge platform extension is active.');
  }));
}

export function deactivate(): void {
  // Nothing to dispose manually; subscriptions are owned by the extension context.
}
