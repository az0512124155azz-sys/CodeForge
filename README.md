# CodeForge

**Bootstrap version: 0.0.11**

CodeForge is a professional desktop IDE built on the open-source Code - OSS foundation.

## Current foundation

- Code - OSS source is now promoted directly to `main`.
- CodeForge product branding is applied in `product.json`.
- Built-in `codeforge-platform` extension is included as the integration layer for CodeForge-specific features.
- Build Center now performs real project detection and build execution instead of showing a placeholder message.
- Build Center currently detects common npm, Gradle/Android, Cargo, CMake and Flutter projects.
- Live build notifications show elapsed time and ETA based on recent build history, while raw stdout/stderr is streamed into the CodeForge Build output channel.
- Active builds can be cancelled and completed build durations are retained locally for improved ETA estimates.
- Failed builds produce a sanitized diagnostic context that is ready for AI provider execution; raw credentials are never included.
- AI provider settings include Auto, Ollama and Bionic/OpenAI-compatible endpoints plus a model selector.
- GitHub Client ID/callback and MCP automatic build-failure settings are now part of CodeForge configuration.

## Product direction

CodeForge is being developed as a daily-use desktop IDE for Windows, macOS, and Linux, with additional Android build tooling. Planned first-class features include:

- Rich Build Center UI with detailed build stages, artifacts, diagnostics and history.
- Actual AI provider execution for Ollama/Bionic and automatic build failure analysis.
- MCP client, permission broker, tools/resources/prompts and event integration.
- GitHub sign-in, repository browsing, create/clone/pull/push, branches, PRs and release publishing.
- Safety Timeline and Git-backed recovery checkpoints.
- Secure credential storage where models never receive raw access tokens.
- Session restoration and close/shutdown protection for unsaved files and running jobs.

## Repository workflow

Development changes from ChatGPT are committed directly to `main` as requested. Automatic branch creation is reserved for CodeForge's own in-app Git/AI safety workflow, where user or AI changes can be isolated and restored safely.

## Upstream and license

CodeForge is based on the MIT-licensed Code - OSS source from the `microsoft/vscode` repository. Microsoft Visual Studio Code trademarks and Microsoft-specific product branding are not part of CodeForge branding.
