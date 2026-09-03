# GitHub Authentication Plan

## User flow

1. User clicks `Accounts > Sign in with GitHub` inside CodeForge.
2. CodeForge starts a temporary loopback HTTP listener on `127.0.0.1`.
3. CodeForge opens the system browser to GitHub authorization.
4. User signs in and authorizes CodeForge.
5. GitHub redirects back to the loopback callback.
6. CodeForge validates the OAuth state/PKCE verifier, completes the exchange, stores credentials in the OS credential vault, closes the temporary listener, and refreshes GitHub UI state.

## Callback

Registered callback base:

`http://127.0.0.1/github/callback`

For desktop loopback flows, the runtime may use a temporary local port where supported by GitHub's loopback redirect behavior.

## Public configuration

The GitHub Client ID is not a secret and may be shipped in product configuration. CodeForge will read it from a dedicated product/auth configuration value.

Do not commit:
- Client Secret
- App private key
- Access token
- Refresh token

## Secret handling

CodeForge never inserts GitHub credentials into prompts, chat history, terminal output, logs, MCP arguments, or workspace files.

AI and MCP tools call a permission-broker API such as:
- `github.repositories.read`
- `github.contents.read`
- `github.branch.create`
- `github.push`
- `github.release.create`

The broker performs authorization and credential use outside model context.

## Permissions model

Default user-facing scopes/policies should separately control:
- Read repositories
- Read repository contents
- Create branches
- Write commits/checkpoints
- Push
- Create pull requests
- Merge to protected/default branch
- Create releases/upload build artifacts
- Delete branches

High-impact operations remain separately revocable even when GitHub authentication is active.

## Build publishing

Source changes are pushed through branches. Compiled installers/packages should normally be uploaded as release artifacts rather than committed as large binary files into Git history.
