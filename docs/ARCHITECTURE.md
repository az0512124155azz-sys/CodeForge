# CodeForge Architecture

## Foundation

CodeForge is designed as a true desktop IDE based on Code - OSS rather than a web mockup. The production application must inherit the mature workbench, editor, terminal, extension host, source-control, debugging, language-service, workspace, settings, keybinding, theme, and recovery architecture of Code - OSS and extend it with CodeForge services.

## CodeForge services

### AI Provider Layer
- Auto provider selection.
- Ollama local provider.
- Bionic / OpenAI-compatible local endpoint provider.
- Model discovery and health status.
- No secret is ever placed into model context.

### MCP Runtime
- MCP server registry.
- Connection status and logs.
- Tools/resources/prompts discovery.
- Permission broker in front of every privileged tool.
- Scoped grants per server and per workspace.
- Build events available through MCP, including progress, elapsed time, ETA, stage, logs and failure diagnostics.

### Build Center
Targets:
- Windows: EXE/MSI/portable where supported by the project toolchain.
- Linux: AppImage/DEB/RPM/tar where supported.
- Android: APK/AAB.
- macOS: application/package targets where supported and built on macOS runners.

Each build exposes:
- Current stage.
- Progress.
- Elapsed time.
- Estimated remaining time.
- Raw command/log stream.
- Structured diagnostics.
- Output artifacts.
- Build history.

Build failures may be sent automatically to a connected AI according to user policy: off, analyze, suggest fix, or auto-fix in an isolated branch.

### Safety Timeline
- Local recoverable checkpoints for editor/workspace state.
- Git checkpoints for meaningful operations.
- AI writes use isolated branches by default.
- Main is not modified directly by autonomous agents.
- Restore/compare/revert are first-class actions.

### GitHub Integration
- Interactive sign-in from inside the desktop application.
- Browser-based authorization returns to CodeForge automatically.
- Client ID is public configuration.
- Access/refresh tokens are stored only through the OS credential store.
- Tokens are never given directly to AI models or MCP clients.
- Permission broker performs GitHub operations on behalf of the model after policy evaluation.

### Session and Shutdown Safety
- Restore open folders/workspaces and editor state after restart.
- Closing with dirty editors asks Save / Don't Save / Cancel.
- Active build/agent/git/upload operations surface a blocking shutdown/close confirmation with status and ETA.
- The application must never block OS shutdown indefinitely.

## Branch policy

- `main`: stable integration branch.
- Human feature work: `feature/<name>`.
- AI work: `ai/<task>-<timestamp>`.
- Build-repair work: `build/<target>-fix-<timestamp>`.
- Bootstrap work: `bootstrap/codeoss-core`.

Branches still contain commits internally; the UI presents them as recoverable work units so users do not need to micromanage commits for every operation.
