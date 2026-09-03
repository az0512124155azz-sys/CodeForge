# CodeForge

**Bootstrap version: 0.0.10**

CodeForge is a professional desktop IDE built on the open-source Code - OSS foundation.

## Current foundation

- Code - OSS source is now promoted directly to `main`.
- CodeForge product branding is applied in `product.json`.
- Built-in `codeforge-platform` extension is included as the integration layer for CodeForge-specific features.
- Initial commands and settings are present for Build Center, AI, MCP, and GitHub.
- AI provider settings include Auto, Ollama, and Bionic/OpenAI-compatible endpoints.

## Product direction

CodeForge is being developed as a daily-use desktop IDE for Windows, macOS, and Linux, with additional Android build tooling. Planned first-class features include:

- Build Center with live stages, elapsed time, ETA, logs, diagnostics and history.
- AI-assisted build failure analysis and isolated AI fix branches inside the product workflow.
- Ollama and Bionic local AI support.
- MCP client, permission broker, tools/resources/prompts and event integration.
- GitHub sign-in, repository browsing, create/clone/pull/push, branches, PRs and release publishing.
- Safety Timeline and Git-backed recovery checkpoints.
- Secure credential storage where models never receive raw access tokens.
- Session restoration and close/shutdown protection for unsaved files and running jobs.

## Repository workflow

Development changes from ChatGPT are committed directly to `main` as requested. Automatic branch creation is reserved for CodeForge's own in-app Git/AI safety workflow, where user or AI changes can be isolated and restored safely.

## Upstream and license

CodeForge is based on the MIT-licensed Code - OSS source from the `microsoft/vscode` repository. Microsoft Visual Studio Code trademarks and Microsoft-specific product branding are not part of CodeForge branding.
