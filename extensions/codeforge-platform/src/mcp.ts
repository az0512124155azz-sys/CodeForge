import * as vscode from 'vscode';

const MCP_COMMANDS = {
  listServers: 'workbench.mcp.listServer',
  addConfiguration: 'workbench.mcp.addConfiguration',
  showInstalled: 'workbench.mcp.showInstalledServers',
  browseResources: 'workbench.mcp.browseResources',
  openUserConfig: 'workbench.mcp.openUserMcpJson',
  openWorkspaceConfig: 'workbench.mcp.openWorkspaceMcpJson',
  resetTrust: 'workbench.mcp.resetTrust'
} as const;

export async function openMCPManager(): Promise<void> {
  await vscode.commands.executeCommand(MCP_COMMANDS.listServers);
}

export async function addMCPServer(): Promise<void> {
  await vscode.commands.executeCommand(MCP_COMMANDS.addConfiguration);
}

export async function showInstalledMCPServers(): Promise<void> {
  await vscode.commands.executeCommand(MCP_COMMANDS.showInstalled);
}

export async function browseMCPResources(): Promise<void> {
  await vscode.commands.executeCommand(MCP_COMMANDS.browseResources);
}

export async function openMCPConfiguration(): Promise<void> {
  const scope = await vscode.window.showQuickPick([
    { label: 'User MCP configuration', command: MCP_COMMANDS.openUserConfig },
    { label: 'Workspace MCP configuration', command: MCP_COMMANDS.openWorkspaceConfig }
  ], {
    title: 'CodeForge MCP Configuration',
    placeHolder: 'Choose where to configure MCP servers'
  });
  if (scope) {
    await vscode.commands.executeCommand(scope.command);
  }
}

export async function openMCPControlCenter(): Promise<void> {
  const action = await vscode.window.showQuickPick([
    { label: '$(server) Manage MCP servers', id: 'manage' },
    { label: '$(add) Add MCP server', id: 'add' },
    { label: '$(extensions) Show installed MCP servers', id: 'installed' },
    { label: '$(files) Browse MCP resources', id: 'resources' },
    { label: '$(json) Open mcp.json', id: 'config' },
    { label: '$(shield) Reset MCP trust decisions', id: 'trust' }
  ], {
    title: 'CodeForge MCP',
    placeHolder: 'MCP is powered by the full Code-OSS MCP workbench runtime'
  });

  if (!action) return;
  switch (action.id) {
    case 'manage':
      await openMCPManager();
      break;
    case 'add':
      await addMCPServer();
      break;
    case 'installed':
      await showInstalledMCPServers();
      break;
    case 'resources':
      await browseMCPResources();
      break;
    case 'config':
      await openMCPConfiguration();
      break;
    case 'trust':
      await vscode.commands.executeCommand(MCP_COMMANDS.resetTrust);
      break;
  }
}
