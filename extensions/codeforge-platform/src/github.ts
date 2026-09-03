import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { createHash, randomBytes } from 'crypto';

interface StoredGitHubToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scope?: string;
  tokenType?: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export interface GitHubUser {
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  description?: string | null;
}

interface GitHubContentResponse {
  type: string;
  name: string;
  path: string;
  encoding?: string;
  content?: string;
  html_url?: string;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function requestText(urlText: string, options: {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
} = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlText);
    const transport = url.protocol === 'https:' ? https : http;
    const headers = { ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(options.body));
    }

    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });

    request.setTimeout(options.timeoutMs ?? 30000, () => request.destroy(new Error('GitHub request timed out.')));
    request.on('error', reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class GitHubService {
  private static readonly tokenSecret = 'codeforge.github.oauthToken';

  constructor(private readonly context: vscode.ExtensionContext) {}

  private configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('codeforge.github');
  }

  private clientId(): string {
    return this.configuration().get<string>('clientId', '').trim();
  }

  private scopes(): string[] {
    return this.configuration().get<string[]>('scopes', ['repo', 'read:user']);
  }

  private callbackBase(): URL {
    const configured = this.configuration().get<string>('callbackUrl', 'http://127.0.0.1/github/callback');
    const url = new URL(configured);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
    if (url.protocol !== 'http:' || !loopback) {
      throw new Error('CodeForge GitHub callback must be an HTTP loopback URL using 127.0.0.1 or ::1.');
    }
    return url;
  }

  private async readStoredToken(): Promise<StoredGitHubToken | undefined> {
    const raw = await this.context.secrets.get(GitHubService.tokenSecret);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredGitHubToken;
    } catch {
      await this.context.secrets.delete(GitHubService.tokenSecret);
      return undefined;
    }
  }

  private async storeToken(response: GitHubTokenResponse): Promise<StoredGitHubToken> {
    if (!response.access_token) {
      throw new Error(response.error_description ?? response.error ?? 'GitHub did not return an access token.');
    }
    const now = Date.now();
    const token: StoredGitHubToken = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: response.expires_in ? now + response.expires_in * 1000 : undefined,
      refreshTokenExpiresAt: response.refresh_token_expires_in ? now + response.refresh_token_expires_in * 1000 : undefined,
      scope: response.scope,
      tokenType: response.token_type
    };
    await this.context.secrets.store(GitHubService.tokenSecret, JSON.stringify(token));
    return token;
  }

  private async exchangeToken(parameters: URLSearchParams): Promise<StoredGitHubToken> {
    const result = await requestText('https://github.com/login/oauth/access_token', {
      method: 'POST',
      timeoutMs: 30000,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'CodeForge-IDE'
      },
      body: parameters.toString()
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`GitHub token exchange failed with HTTP ${result.status}.`);
    }
    return this.storeToken(parseJson<GitHubTokenResponse>(result.body, 'GitHub token exchange'));
  }

  private async refreshToken(token: StoredGitHubToken): Promise<StoredGitHubToken | undefined> {
    if (!token.refreshToken) return undefined;
    if (token.refreshTokenExpiresAt && token.refreshTokenExpiresAt <= Date.now()) return undefined;
    const clientId = this.clientId();
    if (!clientId) return undefined;
    try {
      return await this.exchangeToken(new URLSearchParams({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken
      }));
    } catch {
      return undefined;
    }
  }

  private async accessToken(interactive: boolean): Promise<string | undefined> {
    let token = await this.readStoredToken();
    if (token) {
      if (!token.expiresAt || token.expiresAt > Date.now() + 60000) {
        return token.accessToken;
      }
      token = await this.refreshToken(token);
      if (token) return token.accessToken;
      await this.context.secrets.delete(GitHubService.tokenSecret);
    }
    if (!interactive) return undefined;
    const signedIn = await this.signIn();
    return signedIn ? (await this.readStoredToken())?.accessToken : undefined;
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(await this.accessToken(false));
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(GitHubService.tokenSecret);
  }

  async signIn(): Promise<GitHubUser | undefined> {
    const clientId = this.clientId();
    if (!clientId) {
      const action = await vscode.window.showWarningMessage('CodeForge GitHub Client ID is not configured yet.', 'Open GitHub settings');
      if (action === 'Open GitHub settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'codeforge.github.clientId');
      }
      return undefined;
    }

    const callback = this.callbackBase();
    const verifier = base64Url(randomBytes(64));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const state = base64Url(randomBytes(32));

    const authorizationCode = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        callback();
        setTimeout(() => server.close(), 50);
      };

      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (requestUrl.pathname !== callback.pathname) {
          response.statusCode = 404;
          response.end('Not found');
          return;
        }

        const returnedState = requestUrl.searchParams.get('state');
        const error = requestUrl.searchParams.get('error');
        const description = requestUrl.searchParams.get('error_description');
        const code = requestUrl.searchParams.get('code');

        if (returnedState !== state) {
          response.statusCode = 400;
          response.end('CodeForge rejected the callback because the OAuth state did not match.');
          finish(() => reject(new Error('GitHub OAuth state validation failed.')));
          return;
        }
        if (error) {
          response.statusCode = 400;
          response.end('GitHub authorization was not completed. You can return to CodeForge.');
          finish(() => reject(new Error(description ?? error)));
          return;
        }
        if (!code) {
          response.statusCode = 400;
          response.end('Missing authorization code.');
          finish(() => reject(new Error('GitHub callback did not include an authorization code.')));
          return;
        }

        const address = server.address();
        if (!address || typeof address === 'string') {
          response.statusCode = 500;
          response.end('CodeForge could not determine the callback port.');
          finish(() => reject(new Error('CodeForge could not determine the loopback callback port.')));
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h2>CodeForge connected to GitHub</h2><p>You can close this browser tab and return to CodeForge.</p></body></html>');
        finish(() => resolve({ code, redirectUri: `http://127.0.0.1:${address.port}${callback.pathname}` }));
      });

      server.on('error', error => finish(() => reject(error)));

      server.listen(0, '127.0.0.1', async () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(() => reject(new Error('CodeForge could not open the GitHub callback listener.')));
          return;
        }
        const redirectUri = `http://127.0.0.1:${address.port}${callback.pathname}`;
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.searchParams.set('client_id', clientId);
        authorize.searchParams.set('redirect_uri', redirectUri);
        authorize.searchParams.set('scope', this.scopes().join(' '));
        authorize.searchParams.set('state', state);
        authorize.searchParams.set('code_challenge', challenge);
        authorize.searchParams.set('code_challenge_method', 'S256');
        authorize.searchParams.set('prompt', 'select_account');
        const opened = await vscode.env.openExternal(vscode.Uri.parse(authorize.toString()));
        if (!opened) {
          finish(() => reject(new Error('CodeForge could not open the GitHub authorization page.')));
        }
      });

      timeout = setTimeout(() => finish(() => reject(new Error('GitHub sign-in timed out after five minutes.'))), 5 * 60 * 1000);
    });

    await this.exchangeToken(new URLSearchParams({
      client_id: clientId,
      code: authorizationCode.code,
      redirect_uri: authorizationCode.redirectUri,
      code_verifier: verifier
    }));

    return this.getCurrentUser();
  }

  private async apiRequest<T>(pathName: string, options: { method?: 'GET' | 'POST'; body?: unknown; interactive?: boolean } = {}): Promise<T> {
    const token = await this.accessToken(options.interactive ?? true);
    if (!token) throw new Error('CodeForge is not signed in to GitHub.');
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const result = await requestText(`https://api.github.com${pathName}`, {
      method: options.method ?? 'GET',
      timeoutMs: 30000,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'CodeForge-IDE',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body
    });
    if (result.status < 200 || result.status >= 300) {
      let detail = result.body.slice(0, 600);
      try {
        const parsed = JSON.parse(result.body) as { message?: string };
        detail = parsed.message ?? detail;
      } catch {
        // Keep raw detail.
      }
      throw new Error(`GitHub API ${result.status}: ${detail}`);
    }
    return parseJson<T>(result.body, 'GitHub API');
  }

  async getCurrentUser(): Promise<GitHubUser> {
    return this.apiRequest<GitHubUser>('/user', { interactive: true });
  }

  async listRepositories(): Promise<GitHubRepository[]> {
    return this.apiRequest<GitHubRepository[]>('/user/repos?sort=updated&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member', { interactive: true });
  }

  async createRepository(name: string, isPrivate: boolean, description?: string): Promise<GitHubRepository> {
    return this.apiRequest<GitHubRepository>('/user/repos', {
      method: 'POST',
      interactive: true,
      body: {
        name,
        private: isPrivate,
        description: description || undefined,
        auto_init: false
      }
    });
  }

  async readRepositoryFile(repository: string, filePath: string, ref?: string): Promise<{ name: string; path: string; text: string; htmlUrl?: string }> {
    const [owner, name] = repository.split('/');
    if (!owner || !name) throw new Error('Repository must be in owner/name format.');
    const encodedPath = filePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const response = await this.apiRequest<GitHubContentResponse>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodedPath}${query}`, { interactive: true });
    if (response.type !== 'file' || !response.content) {
      throw new Error('The selected GitHub path is not a readable file.');
    }
    const text = response.encoding === 'base64'
      ? Buffer.from(response.content.replace(/\n/g, ''), 'base64').toString('utf8')
      : response.content;
    return { name: response.name, path: response.path, text, htmlUrl: response.html_url };
  }
}
