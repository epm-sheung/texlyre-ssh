# TeXlyre + SSH

A fork of **[TeXlyre](https://github.com/TeXlyre/texlyre)**, the local-first LaTeX & Typst editor, that adds **SSH/SFTP support**: open a paper that lives on any SSH server (a cluster, a lab machine, a VPS), edit and compile it in the browser, and push your changes back.

## What's new

- **Import from server**: copy a folder from any SSH host into a TeXlyre project.
- **Push via SFTP**: upload only the files you changed.
- **Safe by default**: files edited on the server are never overwritten (unless you Force push), and nothing TeXlyre didn't create is ever deleted, so build outputs next to your paper are left alone.
- **Works like `ssh`**: uses your `~/.ssh/config`, keys, `known_hosts`, ProxyJump/ProxyCommand, key passphrases, and MFA/Duo prompts. You can also type `user@host[:port]` directly.
- **One login per session**: MFA is asked once; the connection is reused until it's idle for 30 minutes.

Browsers can't open SSH connections, so a small local helper, [`sftp-bridge/`](sftp-bridge/README.md), holds the connection on your machine. Your keys never leave `~/.ssh`.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev                              # TeXlyre at http://localhost:5173/texlyre/
cd sftp-bridge && npm install && node bridge.cjs   # prints a token (saved; paste once)
```

1. In TeXlyre, sign up (local account), then paste the token under **Settings → Backup → SFTP**.
2. Open a project, click **Backup ▾ → SFTP → Connect over SFTP**, pick a host, then browse to the folder.
3. **Import from server** to bring the files in; **Push via SFTP** to send changes back.

## Everything else

All other features (real-time collaboration, in-browser LaTeX/Typst compilation, Git backups, plugins) are unchanged from upstream; see the [TeXlyre README](https://github.com/TeXlyre/texlyre#readme) and [docs](https://texlyre.org/docs).

## License

AGPL-3.0, same as TeXlyre. This is a modified version of TeXlyre: the SFTP backup plugin (`extras/backup/sftp/`), the local bridge (`sftp-bridge/`), and small supporting changes were added in September 2026. All credit for TeXlyre itself goes to the [TeXlyre authors](https://github.com/TeXlyre/texlyre).
