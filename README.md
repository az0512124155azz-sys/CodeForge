# CodeForge

**Bootstrap version: 0.0.12**

CodeForge is a professional desktop IDE built on the open-source Code - OSS foundation.

## Current foundation

- Code - OSS source is promoted directly to `main`.
- CodeForge product branding is applied in `product.json`.
- Built-in `codeforge-platform` extension is included as the integration layer for CodeForge-specific features.
- Build Center performs real project detection and build execution for common npm, Gradle/Android, Cargo, CMake and Flutter projects.
- Live build notifications show the current inferred stage, elapsed time and ETA based on recent build history, while raw stdout/stderr is streamed into the CodeForge Build output channel.
- Active builds can be cancelled and completed build durations are retained locally for improved ETA estimates.
- Ollama and Bionic/OpenAI-compatible AI execution is now wired into CodeForge instead of being a placeholder.
- Auto AI mode tries Ollama first and falls back to Bionic/OpenAI-compatible local endpoints.
- CodeForge can enumerate provider models and select a coding-oriented model automatically, or use a manually configured model.
- Failed builds can automatically invoke CodeForge Build Doctor and open the AI diagnosis directly in the editor.
- Build logs are sanitized before AI analysis; GitHub tokens, API keys, Authorization headers, URL credentials and common secret environment values are redacted.
- Optional Bionic API keys are stored in VS Code SecretStorage and are never placed in settings, Git, build logs or model prompts.
- GitHub Client ID/callback and MCP automatic build-failure settings are part of CodeForge configuration.

## Product direction

CodeForge is being developed as a daily-use desktop IDE for Windows, macOS and Linux, with additional Android build tooling. Planned first-class features include:

- Rich Build Center UI with detailed build stages, artifacts, diagnostics and history.
- MCP management and event integration using the Code-OSS MCP platform already present in the workbench.
- GitHub sign-in, repository browsing, create/clone/pull/push, branches, PRs and release publishing.
- Safety Timeline and Git-backed recovery checkpoints.
- Secure permission broker so models can invoke authorized actions without receiving raw access tokens.
- Session restoration and close/shutdown protection for unsaved files and running jobs.

## Repository workflow

Development changes from ChatGPT are committed directly to `main` as requested. Automatic branch creation is reserved for CodeForge's own in-app Git/AI safety workflow, where user or AI changes can be isolated and restored safely.

## Upstream and license

CodeForge is based on the MIT-licensed Code - OSS source from the `microsoft/vscode` repository. Microsoft Visual Studio Code trademarks and Microsoft-specific product branding are not part of CodeForge branding.
