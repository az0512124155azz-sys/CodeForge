import * as vscode from 'vscode';
import * as http from 'http';
import { createHash } from 'crypto';
import { sanitizeDiagnosticText, BuildFailureAnalysisInput } from './ai';

const MCP_COMMANDS = {
  listServers: 'workbench.mcp.listServer',
  addConfiguration: 'workbench.mcp.addConfiguration',
  showInstalled: 'workbench.mcp.showInstalledServers',
  browseResources: 'workbench.mcp.browseResources',
  openUserConfig: 'workbench.mcp.openUserMcpJson',
  openWorkspaceConfig: 'workbench.mcp.openWorkspaceMcpJson',
  resetTrust: 'workbench.mcp.resetTrust'
} as const;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface McpSession {
  readonly address: vscode.Uri;
  readonly id: string;
  nextId: number;
}

interface BuildFailureDestination {
  readonly server: vscode.McpGatewayServer;
  readonly session: McpSession;
  readonly tool: McpTool;
}

function postJson<T>(address: vscode.Uri, body: unknown, sessionId?: string): Promise<{ body: JsonRpcResponse<T>; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    if (address.scheme !== 'http' || !/^127\.0\.0\.1:\d+$/.test(address.authority)) {
      reject(new Error('CodeForge only connects to MCP gateway endpoints on 127.0.0.1.'));
      return;
    }
    const raw = JSON.stringify(body);
    const request = http.request(address.toString(true), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(raw)),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
      }
    }, response => {
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > 1024 * 1024) {
          request.destroy(new Error('MCP gateway response exceeded 1 MB.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`MCP gateway returned HTTP ${response.statusCode ?? 0}.`));
          return;
        }
        try {
          resolve({
            body: text ? JSON.parse(text) as JsonRpcResponse<T> : {},
            sessionId: response.headers['mcp-session-id'] as string | undefined
          });
        } catch {
          reject(new Error('MCP gateway returned invalid JSON.'));
        }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('MCP gateway request timed out.')));
    request.on('error', reject);
    request.end(raw);
  });
}

async function rpc<T>(session: McpSession, method: string, params?: Record<string, unknown>): Promise<T> {
  const response = await postJson<T>(session.address, {
    jsonrpc: '2.0',
    id: session.nextId++,
    method,
    ...(params ? { params } : {})
  }, session.id);
  if (response.body.error) {
    throw new Error(`MCP ${method} failed: ${response.body.error.message ?? response.body.error.code ?? 'unknown error'}`);
  }
  if (response.body.result === undefined) throw new Error(`MCP ${method} returned no result.`);
  return response.body.result;
}

async function openSession(address: vscode.Uri): Promise<McpSession> {
  const initialized = await postJson(address, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'CodeForge Build Router', version: '0.0.18' }
    }
  });
  if (initialized.body.error) throw new Error(initialized.body.error.message ?? 'MCP initialization failed.');
  if (!initialized.sessionId) throw new Error('MCP gateway did not create a session.');
  const session: McpSession = { address, id: initialized.sessionId, nextId: 2 };
  await postJson(address, { jsonrpc: '2.0', method: 'notifications/initialized' }, session.id);
  return session;
}

function safeBuildFailure(input: BuildFailureAnalysisInput): Record<string, unknown> {
  return {
    event: 'build.failed',
    target: sanitizeDiagnosticText(input.target),
    recipe: sanitizeDiagnosticText(input.recipe),
    command: sanitizeDiagnosticText([input.command, ...input.args].join(' ')),
    exitCode: input.exitCode,
    sanitizedLog: sanitizeDiagnosticText(input.log),
    privacy: {
      sanitized: true,
      rawLogIncluded: false,
      environmentIncluded: false,
      credentialsIncluded: false
    }
  };
}

export class MCPPermissionBroker implements vscode.Disposable {
  private static readonly grantsKey = 'codeforge.mcp.permissionGrants';
  private gateway: vscode.McpGateway | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.gateway?.dispose();
    this.gateway = undefined;
  }

  async resetPermissions(): Promise<void> {
    await this.context.globalState.update(MCPPermissionBroker.grantsKey, undefined);
  }

  private allowedToolNames(): Set<string> {
    const configured = vscode.workspace.getConfiguration('codeforge.mcp')
      .get<string[]>('buildFailureToolNames', ['build.failed', 'build_failed', 'analyze_build_failure']);
    return new Set(configured.map(name => name.trim()).filter(Boolean));
  }

  private grantId(destination: BuildFailureDestination): string {
    const definitions = vscode.lm.mcpServerDefinitions
      .filter(definition => definition.label === destination.server.label)
      .map(definition => {
        if ('command' in definition) {
          return JSON.stringify({ type: 'stdio', command: definition.command, args: definition.args, cwd: definition.cwd?.toString(), version: definition.version });
        }
        return JSON.stringify({ type: 'http', uri: definition.uri.toString(), version: definition.version });
      })
      .sort();
    const fingerprint = createHash('sha256').update(definitions.join('\n')).digest('hex');
    return `${destination.server.label}\n${destination.tool.name}\n${fingerprint}`;
  }

  private async authorize(destination: BuildFailureDestination): Promise<boolean> {
    const grants = this.context.globalState.get<string[]>(MCPPermissionBroker.grantsKey, []);
    const grantId = this.grantId(destination);
    if (grants.includes(grantId)) return true;

    const choice = await vscode.window.showWarningMessage(
      `Allow MCP server “${destination.server.label}” to receive sanitized build diagnostics through “${destination.tool.name}”? Raw logs, environment variables and credentials will not be sent.`,
      { modal: true, detail: 'The payload includes the target, recipe, command, exit code, and a redacted diagnostic excerpt (maximum 40,000 characters).' },
      'Allow once',
      'Always allow'
    );
    if (choice === 'Always allow') {
      await this.context.globalState.update(MCPPermissionBroker.grantsKey, [...grants, grantId]);
      return true;
    }
    return choice === 'Allow once';
  }

  async routeBuildFailure(input: BuildFailureAnalysisInput): Promise<boolean> {
    if (!vscode.workspace.getConfiguration('codeforge.mcp').get<boolean>('autoSendBuildFailures', true)) return false;
    this.gateway ??= await vscode.lm.startMcpGateway();
    if (!this.gateway?.servers.length) return false;

    const allowedNames = this.allowedToolNames();
    const destinations: BuildFailureDestination[] = [];
    for (const server of this.gateway.servers) {
      try {
        const session = await openSession(server.address);
        const listed = await rpc<{ tools?: McpTool[] }>(session, 'tools/list');
        for (const tool of listed.tools ?? []) {
          if (allowedNames.has(tool.name)) destinations.push({ server, session, tool });
        }
      } catch {
        // A disconnected or interactive server must not prevent other authorized
        // MCP destinations, local AI analysis, or the build result from working.
      }
    }
    if (!destinations.length) return false;

    const selected = destinations.length === 1 ? destinations[0] : (await vscode.window.showQuickPick(
      destinations.map(destination => ({
        label: destination.server.label,
        description: destination.tool.name,
        detail: destination.tool.description,
        destination
      })),
      { title: 'Route sanitized build failure to MCP', placeHolder: 'Choose an MCP destination' }
    ))?.destination;
    if (!selected || !(await this.authorize(selected))) return false;

    const result = await rpc<McpToolResult>(selected.session, 'tools/call', {
      name: selected.tool.name,
      arguments: safeBuildFailure(input)
    });
    if (result.isError) throw new Error(`MCP tool ${selected.tool.name} reported an error.`);
    return true;
  }
}

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

export async function openMCPControlCenter(permissionBroker?: MCPPermissionBroker): Promise<void> {
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
      await permissionBroker?.resetPermissions();
      await vscode.commands.executeCommand(MCP_COMMANDS.resetTrust);
      break;
  }
}
