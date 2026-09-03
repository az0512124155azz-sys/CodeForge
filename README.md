# CodeForge

CodeForge is a production-grade desktop IDE built on the open-source Code - OSS foundation, with first-class AI, MCP, GitHub, and cross-platform application build tooling.

## Product goals

- Professional daily-use desktop IDE for Windows, macOS, and Linux.
- Code - OSS workbench/editor architecture as the foundation.
- Git and GitHub workflows built into the IDE.
- Local AI providers: Ollama and Bionic/OpenAI-compatible endpoints.
- MCP client and permission broker with scoped tool access.
- Build Center for Windows, Linux, Android, and later macOS packaging targets.
- Build progress, elapsed time, ETA, diagnostics, raw logs, and AI-assisted failure analysis.
- Safety Timeline: recoverable workspace snapshots and Git-backed checkpoints.
- AI changes isolated in dedicated branches by default.
- Secure credentials: secrets are never exposed directly to AI models.
- Session restore and shutdown/close protection for unsaved work and running jobs.

## Repository policy

`main` is the stable integration branch. Development is performed on dedicated feature/bootstrap branches and merged only after validation.

The first implementation branch is `bootstrap/codeoss-core`.
