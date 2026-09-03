import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export type AIProviderId = 'ollama' | 'bionic';

export interface BuildFailureAnalysisInput {
  target: string;
  recipe: string;
  command: string;
  args: string[];
  exitCode: number | null;
  log: string;
}

export interface AIAnalysisResult {
  provider: AIProviderId;
  model: string;
  content: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: string }>;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

function endpoint(base: string, relative: string): string {
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return new URL(relative.replace(/^\//, ''), normalized).toString();
}

function requestJson<T>(urlText: string, options: RequestOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(urlText);
    const transport = url.protocol === 'https:' ? https : http;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
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
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`AI provider returned HTTP ${status}: ${raw.slice(0, 500)}`));
          return;
        }

        try {
          resolve((raw ? JSON.parse(raw) : {}) as T);
        } catch (error) {
          reject(new Error(`AI provider returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });

    request.setTimeout(options.timeoutMs ?? 5000, () => {
      request.destroy(new Error('AI provider request timed out.'));
    });
    request.on('error', reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function codingModelScore(model: string): number {
  const value = model.toLowerCase();
  let score = 0;
  if (value.includes('coder')) score += 80;
  if (value.includes('code')) score += 60;
  if (value.includes('qwen')) score += 30;
  if (value.includes('deepseek')) score += 30;
  if (value.includes('codestral')) score += 35;
  if (value.includes('starcoder')) score += 35;
  if (value.includes('instruct')) score += 10;
  return score;
}

function chooseModel(models: string[], configured: string): string {
  if (configured && configured !== 'auto') {
    return configured;
  }
  if (!models.length) {
    throw new Error('The AI provider is reachable, but it did not report any installed models.');
  }
  return [...models].sort((a, b) => codingModelScore(b) - codingModelScore(a))[0];
}

export function sanitizeDiagnosticText(input: string): string {
  let text = input;
  text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');
  text = text.replace(/(Authorization\s*:\s*(?:Bearer|token)\s+)[^\s]+/gi, '$1[REDACTED]');
  text = text.replace(/([?&](?:token|key|api_key|access_token|password)=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(https?:\/\/[^:\s/@]+):([^@\s/]+)@/gi, '$1:[REDACTED]@');
  text = text.replace(/\b((?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY)\s*[=:]\s*)[^\s'"`]+/gi, '$1[REDACTED]');
  return text.slice(-40000);
}

export class AIService {
  private static readonly bionicSecretKey = 'codeforge.ai.bionicApiKey';

  constructor(private readonly context: vscode.ExtensionContext) {}

  private configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('codeforge.ai');
  }

  private timeoutMs(): number {
    return this.configuration().get<number>('requestTimeoutMs', 120000);
  }

  private async bionicHeaders(): Promise<Record<string, string>> {
    const key = await this.context.secrets.get(AIService.bionicSecretKey);
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  private async ollamaModels(): Promise<string[]> {
    const base = this.configuration().get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
    const response = await requestJson<OllamaTagsResponse>(endpoint(base, 'api/tags'), { timeoutMs: 3000 });
    return (response.models ?? [])
      .map(item => item.name ?? item.model ?? '')
      .filter((value): value is string => Boolean(value));
  }

  private async bionicModels(): Promise<string[]> {
    const base = this.configuration().get<string>('bionicEndpoint', 'http://127.0.0.1:1234/v1');
    const response = await requestJson<OpenAIModelsResponse>(endpoint(base, 'models'), {
      headers: await this.bionicHeaders(),
      timeoutMs: 3000
    });
    return (response.data ?? []).map(item => item.id ?? '').filter((value): value is string => Boolean(value));
  }

  private async resolveProvider(): Promise<{ provider: AIProviderId; models: string[] }> {
    const configured = this.configuration().get<string>('provider', 'auto');
    if (configured === 'ollama') {
      return { provider: 'ollama', models: await this.ollamaModels() };
    }
    if (configured === 'bionic') {
      return { provider: 'bionic', models: await this.bionicModels() };
    }

    try {
      const models = await this.ollamaModels();
      return { provider: 'ollama', models };
    } catch {
      // Auto mode falls through to the OpenAI-compatible local provider.
    }

    try {
      const models = await this.bionicModels();
      return { provider: 'bionic', models };
    } catch (error) {
      throw new Error(`No local CodeForge AI provider is reachable. Start Ollama or Bionic/LM Studio and try again. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async testConnection(): Promise<{ provider: AIProviderId; models: string[]; selectedModel: string }> {
    const resolved = await this.resolveProvider();
    const configuredModel = this.configuration().get<string>('model', 'auto');
    return {
      provider: resolved.provider,
      models: resolved.models,
      selectedModel: chooseModel(resolved.models, configuredModel)
    };
  }

  async setBionicApiKey(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: 'CodeForge Bionic API Key',
      prompt: 'Stored securely in VS Code SecretStorage. The raw key is never added to prompts, logs, settings, or Git.',
      password: true,
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return false;
    }
    if (!value.trim()) {
      await this.context.secrets.delete(AIService.bionicSecretKey);
      return true;
    }
    await this.context.secrets.store(AIService.bionicSecretKey, value.trim());
    return true;
  }

  async clearBionicApiKey(): Promise<void> {
    await this.context.secrets.delete(AIService.bionicSecretKey);
  }

  async analyzeBuildFailure(input: BuildFailureAnalysisInput): Promise<AIAnalysisResult> {
    const resolved = await this.resolveProvider();
    const configuredModel = this.configuration().get<string>('model', 'auto');
    const model = chooseModel(resolved.models, configuredModel);
    const safeLog = sanitizeDiagnosticText(input.log);
    const systemPrompt = [
      'You are CodeForge Build Doctor, a senior software build and compiler diagnostics assistant.',
      'Find the most likely root cause from the supplied build output.',
      'Give a concise diagnosis, affected file/line when visible, the smallest safe fix, and one verification step.',
      'Do not request, reveal, reconstruct, or echo credentials, API keys, access tokens, passwords, private keys, or secrets.',
      'Never recommend disabling security checks just to make a build pass.',
      'If the log is insufficient, say exactly which additional non-secret command output is needed.'
    ].join(' ');
    const userPrompt = [
      `Target: ${input.target}`,
      `Recipe: ${input.recipe}`,
      `Command: ${input.command} ${input.args.join(' ')}`,
      `Exit code: ${input.exitCode ?? 'unknown'}`,
      '',
      'Sanitized build log:',
      safeLog
    ].join('\n');

    if (resolved.provider === 'ollama') {
      const base = this.configuration().get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
      const response = await requestJson<OllamaChatResponse>(endpoint(base, 'api/chat'), {
        method: 'POST',
        timeoutMs: this.timeoutMs(),
        body: {
          model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          options: { temperature: 0.1 }
        }
      });
      const content = response.message?.content?.trim();
      if (!content) {
        throw new Error('Ollama returned an empty analysis.');
      }
      return { provider: 'ollama', model, content };
    }

    const base = this.configuration().get<string>('bionicEndpoint', 'http://127.0.0.1:1234/v1');
    const response = await requestJson<OpenAIChatResponse>(endpoint(base, 'chat/completions'), {
      method: 'POST',
      timeoutMs: this.timeoutMs(),
      headers: await this.bionicHeaders(),
      body: {
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }
    });
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('Bionic/OpenAI-compatible provider returned an empty analysis.');
    }
    return { provider: 'bionic', model, content };
  }
}
