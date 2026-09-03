# CodeForge

**Bootstrap version: 0.0.17**

CodeForge is a professional desktop IDE built on the open-source Code - OSS foundation.

## Current foundation

- Code - OSS source is promoted directly to `main`.
- CodeForge product branding is applied in `product.json`.
- The approved transparent CodeForge symbol is stored as a reusable repository branding asset and registered as the CodeForge platform extension icon.
- Built-in `codeforge-platform` extension is included as the integration layer for CodeForge-specific features.
- Build Center performs real project detection and build execution for common npm, Gradle/Android, Cargo, CMake and Flutter projects.
- Live build notifications show the current inferred stage, elapsed time and ETA based on recent build history, while raw stdout/stderr is streamed into the CodeForge Build output channel.
- Active builds can be cancelled and completed build durations are retained locally for improved ETA estimates.
- Ollama and Bionic/OpenAI-compatible AI execution is wired into CodeForge.
- Auto AI mode tries Ollama first and falls back to Bionic/OpenAI-compatible local endpoints.
- CodeForge enumerates provider models and can automatically prefer coding-oriented models.
- Failed builds can automatically invoke CodeForge Build Doctor and open the AI diagnosis directly in the editor.
- Build logs are sanitized before AI analysis; GitHub tokens, API keys, Authorization headers, URL credentials and common secret environment values are redacted.
- Optional Bionic API keys are stored in SecretStorage and are never placed in settings, Git, build logs or model prompts.
- GitHub desktop sign-in uses a native OAuth authorization-code + PKCE implementation with a dynamic 127.0.0.1 loopback listener and strict OAuth state validation.
- The public GitHub OAuth Client ID is now configured in CodeForge; no GitHub client secret is embedded in the application or repository.
- GitHub access and refresh tokens are stored only in SecretStorage. CodeForge does not require a client secret in the desktop app.
- GitHub controls include sign-in/out, account status, repository listing, repository creation, clone, push, pull, sync and reading a file directly from a repository through the GitHub API.
- GitHub OAuth scopes are configurable so users can reduce account access when their workflow permits it.
- CodeForge MCP controls use the full MCP implementation already present in the Code-OSS workbench: server management, add server, installed servers, resources, configuration and trust controls.
- Safety Timeline creates recoverable Git-backed checkpoints through a temporary Git index, so it can capture tracked and new nonignored files without changing the user's real staging area or moving the active branch.
- Safety Timeline can restore a checkpoint without moving the branch pointer, creates a safety checkpoint before restore, and can create isolated `codeforge/ai/...` branches for AI tasks.
- Build Center can automatically create a Safety Timeline checkpoint before a build.
- CodeForge platform TypeScript validation and extension manifest validation are green in GitHub Actions after the latest Safety Timeline integration.

## Product direction

CodeForge is being developed as a daily-use desktop IDE for Windows, macOS and Linux, with additional Android build tooling. Next major work includes:

- Rich Build Center UI with detailed stages, artifacts, diagnostics and persistent history.
- MCP build-event routing so authorized MCP-connected AI can receive sanitized failures automatically.
- GitHub release publishing for successful build artifacts.
- Secure permission broker so models can invoke authorized actions without receiving raw access tokens.
- Session restoration and close/shutdown protection for unsaved files and running jobs.
- Cross-platform CodeForge packaging and installer validation on Windows, macOS and Linux.

## Repository workflow

Development changes from ChatGPT are committed directly to `main` as requested. Automatic branch creation is reserved for CodeForge's own in-app Git/AI safety workflow, where user or AI changes can be isolated and restored safely.

## Upstream and license

CodeForge is based on the MIT-licensed Code - OSS source from the `microsoft/vscode` repository. Microsoft Visual Studio Code trademarks and Microsoft-specific product branding are not part of CodeForge branding.
