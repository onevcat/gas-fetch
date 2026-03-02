# gas-fetch

CLI tool to execute [Google Apps Script](https://developers.google.com/apps-script) web apps, with automatic Google Workspace authentication.

## Problem

Google Apps Script web apps deployed within a Workspace organization (e.g. `script.google.com/a/macros/example.com/...`) require Google authentication. This makes them inaccessible from `curl`, scripts, or AI agents — even if the user has a valid account.

**gas-fetch** solves this by using a real browser session (via [Playwright](https://playwright.dev/)) with a persistent profile. You log in once, and subsequent calls reuse the session automatically — including handling daily session expiry by auto-clicking the account selector.

## Install

```bash
npm install -g gas-fetch
```

Chromium is installed automatically via the `postinstall` script. If it doesn't run, install it manually:

```bash
npx playwright install chromium
```

### Install from source

```bash
git clone https://github.com/user/gas-fetch.git
cd gas-fetch
npm install
npm link   # makes `gas` command available globally
```

## Quick Start

### 1. First-time login

Open a browser window and log in with your Google account:

```bash
gas https://script.google.com/.../exec --login
```

Complete the login in the browser. The session is saved to `~/.config/gas-fetch/profiles/` — you only need to do this once (or when your session fully expires).

### 2. Fetch your web app

```bash
# GET request — output goes to stdout
gas https://script.google.com/.../exec

# With query parameters
gas https://script.google.com/.../exec query=newer_than:1d limit=5

# POST request with JSON body (triggers doPost in your GAS)
gas https://script.google.com/.../exec --post '{"action":"search","q":"hello"}'

# Pipe to jq
gas https://script.google.com/.../exec | jq '.items[0]'
```

### 3. Use the environment variable

```bash
export GAS_URL="https://script.google.com/.../exec"
gas                          # uses GAS_URL
gas query=newer_than:3d      # uses GAS_URL with params
```

## How It Works

```
gas                       Playwright (headless)           GAS Web App
 |                              |                             |
 |-- launch browser ---------->|                             |
 |                              |-- navigate to GAS URL ----->|
 |                              |                             |
 |                              |<-- 302 redirect ------------|
 |                              |                             |
 |                       [session valid?]                      |
 |                        yes: continue                       |
 |                        no:  auto-click account selector    |
 |                              |                             |
 |                              |<-- 200 response ------------|
 |<-- stdout: response body ----|                             |
```

- **First run (`--login`)**: Opens a visible browser for manual Google login. Session cookies are saved to a local profile directory.
- **Subsequent runs**: Launches a headless browser that reuses the saved session. If the session has expired (e.g. daily Workspace policy), it automatically clicks through the account selector.
- **Full re-login**: If the session is completely invalid (password change, etc.), run with `--login` again.

## Options

| Option | Description |
|---|---|
| `<url>` | GAS web app URL (or set `GAS_URL` env var) |
| `key=value` | Query parameters passed to the web app |
| `--login` | Open a visible browser for manual login |
| `--post <json>` | Send a POST request with JSON body |
| `--profile <dir>` | Custom browser profile directory |
| `--timeout <ms>` | Navigation timeout (default: 30000) |
| `-h, --help` | Show help |

## Environment Variables

| Variable | Description |
|---|---|
| `GAS_URL` | Default GAS web app URL |
| `GAS_FETCH_PROFILES` | Custom base directory for browser profiles (default: `~/.config/gas-fetch/profiles/`) |

## Browser Profiles

Each GAS URL gets its own browser profile directory (derived from a hash of the URL), so different web apps don't share sessions. Profiles are stored in `~/.config/gas-fetch/profiles/` by default.

To see where your profiles are stored:

```bash
ls ~/.config/gas-fetch/profiles/
```

To reset a session, simply delete the corresponding profile directory and run `--login` again.

## Use with AI Agents

gas-fetch is designed to be called by AI agents or automation scripts. Status messages go to **stderr**, and only the web app response goes to **stdout**:

```bash
# In a script or agent tool
RESULT=$(gas "$GAS_URL" 2>/dev/null)
echo "$RESULT" | jq .
```

## Limitations

- Requires a Chromium browser (installed automatically via Playwright)
- Session cookies expire based on your Workspace admin policy — gas-fetch handles daily account-selector re-auth automatically, but a full re-login requires `--login`
- Not suitable for high-frequency concurrent calls (each invocation launches a browser)

## License

MIT
