# texlyre-sftp-bridge

Local WebSocket ↔ SSH/SFTP bridge for the TeXlyre SFTP backup plugin
(`texlyre/extras/backup/sftp`). Browsers cannot open TCP sockets, so TeXlyre
talks JSON over `ws://127.0.0.1:7050` to this process, which owns the SSH
connection and uses your `~/.ssh/config`, keys and `known_hosts`.

Shaped like a Chelys recipe (`WS_PORT`, loopback WebSocket), so Chelys can
manage it later; it also runs standalone.

## Run

```powershell
cd sftp-bridge
npm install
node bridge.cjs            # prints the token
```

In TeXlyre: Settings → Backup → SFTP → paste the token. Then open a project,
click the **SFTP** indicator in the editor header, pick a host alias and a
remote directory, and Push.

| Env | Default | |
| --- | --- | --- |
| `WS_PORT` | `7050` | listen port (loopback only, `WS_HOST=127.0.0.1`) |
| `BRIDGE_TOKEN` | random per run | fixed token if you don't want to re-paste |
| `ALLOWED_ORIGINS` | localhost:5173, texlyre.org, texlyre.github.io | comma-separated |
| `SSH_CONFIG` | `~/.ssh/config` | |
| `MAX_PAYLOAD_MB` | `64` | largest single file message |
| `SFTP_BRIDGE_ALLOW_NO_TOKEN` | unset | `1` disables the token check. Dev only |

## Security model

- Binds 127.0.0.1 only.
- Any web page can try `ws://127.0.0.1:7050`, so the Origin header must be in
  the allowlist (browsers cannot forge it), and the first message must carry
  the per-run token (blocks other local users/processes).
- Host keys are checked against `known_hosts` (plain + hashed, `[host]:port`,
  `@revoked`). Unknown or changed keys are refused unless your config says
  `StrictHostKeyChecking no|accept-new`. The bridge never writes known_hosts:
  run `ssh <alias>` once to trust a new host.
- Host aliases are restricted to `[A-Za-z0-9._-]` because `%h` reaches
  `ProxyCommand`, which runs in a shell.
- Passphrases and MFA answers are relayed to the TeXlyre modal and never logged.

## SSH support

Agent (`SSH_AUTH_SOCK` or the Windows OpenSSH agent pipe), `IdentityFile`
(default `id_ed25519`/`id_ecdsa`/`id_rsa`), encrypted keys (passphrase prompt),
keyboard-interactive incl. publickey+MFA (Duo-style), password, `ProxyJump`
chains, `ProxyCommand`, `HostKeyAlias`, `UserKnownHostsFile`,
`IdentitiesOnly`, `Port`, `User`, `%h %p %r %n` tokens.

Not supported: `Match` blocks (ssh-config lib limitation), certificates,
`ControlMaster`, a `ProxyCommand` that itself needs a TTY prompt.

## Push semantics

Push-only mirror of the plain project tree into the remote directory, with
`<remoteDir>/.texlyre-sync.json` recording `{sha256, size, mtime}` of every
file the bridge wrote:

- unchanged content → skipped
- server copy edited since last push → **not overwritten** (conflict), unless
  Force push. When size/mtime drift, the server copy is hashed first, so a
  touch/checkout that only changes mtime is not a conflict
- file exists on server but was never pushed by TeXlyre → **not overwritten**,
  unless its content is identical, in which case it is adopted (tracked). This
  is what makes "Import from server, then push" upload nothing
- file deleted locally → deleted on server only if TeXlyre created it and it
  is unchanged; build outputs (`main.pdf`, `*.aux`) are never touched
- local unchanged + server edited → server edit kept

Known gap: an edit on the server that keeps the same size within the same
second as the last push is not detected (SFTP mtime has 1 s resolution).

## Protocol

`{id, op, ...}` → `{id, ok, result}` / `{id, ok: false, error: {code, message, details}}`

| op | params | result |
| --- | --- | --- |
| `hello` | `token` | `{version}` (must be first) |
| `hosts` | | `{hosts}` concrete aliases from ssh config |
| `connect` | `host` | `{user, hostName, port, home}` |
| `plan` | `remoteDir, manifest: [{path, sha256}], force` | `{planId, upload, delete, conflicts, remoteEdited, unchanged}` |
| `put` | `planId, path, content (base64)` | `{path, size}`; content hash must match manifest |
| `commit` | `planId` | summary; fails with `MISSING_UPLOADS` if a planned file was not put |
| `list` | `remoteDir, exclude: [patterns]` | `{files: [{path, size, mtime}], totalBytes, skipped}`; names without `/` match basenames (`build` prunes every build dir), `*` doesn't cross `/`; dir symlinks skipped |
| `get` | `remoteDir, path` | `{content (base64), size, mtime, sha256}`, ≤ 48 MB |
| `disconnect` / `ping` | | |

Server events: `{event: 'auth-prompt', promptId, title, instructions, prompts: [{prompt, echo}]}`
(answer with `{op: 'auth-response', promptId, responses}`) and `{event: 'log', level, message}`.

## Tests

```powershell
node test/e2e.cjs
```

Spawns the bridge against throwaway `ssh2` servers with a throwaway ssh
config (never touches `~/.ssh`): security gates, push/conflict/delete rules,
path traversal, MFA, encrypted key, ProxyJump, ProxyCommand, known_hosts
unknown/mismatch/accept-new, throughput. `test/devServer.cjs <dir>` runs a
test server as alias `devbox` plus the bridge, for manual testing in TeXlyre.

Not yet tested against a real OpenSSH server.
