# CodeForge

**Bootstrap version: 0.0.8**

CodeForge is a professional desktop IDE built on the open-source Code - OSS foundation.

## Current foundation

- Code - OSS source imported into this repository.
- CodeForge product branding applied in `product.json`.
- Built-in `codeforge-platform` extension added as the integration layer for CodeForge-specific features.
- Initial commands and settings added for Build Center, AI, MCP, and GitHub.
- AI provider settings currently include Auto, Ollama, and Bionic/OpenAI-compatible endpoints.

## Product direction

CodeForge is being developed as a daily-use desktop IDE for Windows, macOS, and Linux, with additional Android build tooling. Planned first-class features include:

- Build Center with live stages, elapsed time, ETA, logs, diagnostics and history.
- AI-assisted build failure analysis and isolated AI fix branches.
- Ollama and Bionic local AI support.
- MCP client, permission broker, tools/resources/prompts and event integration.
- GitHub sign-in, repository browsing, create/clone/pull/push, branches, PRs and release publishing.
- Safety Timeline and Git-backed recovery checkpoints.
- Secure credential storage where models never receive raw access tokens.
- Session restoration and close/shutdown protection for unsaved files and running jobs.

## Repository policy

`main` remains the stable branch. CodeForge implementation work is developed on feature branches and merged only after validation.

Current implementation branch: `feature/codeforge-platform-v4`.

## Upstream and license

CodeForge is based on the MIT-licensed Code - OSS source from the `microsoft/vscode` repository. Microsoft Visual Studio Code trademarks and Microsoft-specific product branding are not part of CodeForge branding.
