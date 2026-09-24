# TeXlyre + SSH

Modified based on **[TeXlyre](https://github.com/TeXlyre/texlyre)**, the local-first LaTeX & Typst editor. This version adds **SSH/SFTP support**: work on a paper that lives on any SSH server (an HPC cluster, a lab machine, a VPS) in the browser, and TeXlyre keeps it in sync with the server.

## What's new

- **Two-way sync with the server**: edits you make in TeXlyre are uploaded, and changes made on the server come into TeXlyre. Only changed files are transferred.
- **The server is the source of truth**: when the same file changed on both sides, the server version wins and your TeXlyre version is saved under `.texlyre/sftp-conflicts/<time>/`, so nothing is lost. **Force push** is there for when you want the TeXlyre version to win.
- **Automatic**: after your first **Sync now** in a project, it syncs in the background every 60 s while that project is open.
- **Safe**: build outputs (`build/`, `.aux`, `.log`, …) are never synced. A file you're typing in is never overwritten mid-sentence. Background sync pauses instead of deleting more than 5 files at once.
- **Works like `ssh`**: uses your `~/.ssh/config`, keys, `known_hosts`, ProxyJump/ProxyCommand, key passphrases, and MFA/Duo prompts. You can also type `user@host[:port]` directly.
- **Folder browser and recent servers**: click through folders on the server instead of typing paths, and switch servers in one click.
- **One login per session**: MFA is asked once; the connection is reused until it's idle for 30 minutes.
- **Compile ▶ finds the main file**: it compiles `main.tex` (or the file with `\documentclass`), not whichever file is open.

Browsers can't open SSH connections, so a small local helper, [`sftp-bridge/`](sftp-bridge/README.md), holds the connection on your machine. Your keys never leave `~/.ssh`.

## Quick start

Requires [Node.js](https://nodejs.org/) 20+. Clone this repository, then start everything with one click:

| System | Launcher |
| --- | --- |
| Windows | Double-click **`Start TeXlyre.bat`** |
| macOS | Double-click **`Start TeXlyre.command`** (the first time: right-click → Open) |
| Linux | Run **`./start-texlyre.sh`** in a terminal |

The launcher installs dependencies on first use, starts the TeXlyre dev server and the SFTP bridge, and opens TeXlyre in your browser. It also passes the bridge token to TeXlyre, so there is nothing to paste. On Windows, TeXlyre and the bridge run in two windows; on macOS/Linux, in the launcher's terminal. Keep them open while you work; closing them (or Ctrl+C) stops TeXlyre.

1. In TeXlyre, sign up. The account is local to your browser, so always use the same browser.
2. Open a project, then click **Backup ▾ → SFTP → Connect over SFTP**.
3. Enter a host, browse to the folder, and click **Use this folder**. The first sync runs right away and brings the server files in.
4. Edit as usual. Changes go to the server within a minute, or click **Sync now**.

<details>
<summary>Starting it by hand instead</summary>

```bash
npm install
npx vite --port 5173                     # TeXlyre at http://localhost:5173/texlyre/
node sftp-bridge/bridge.cjs              # in a second terminal (after npm install in sftp-bridge/)
```

Then paste the `token:` printed by the bridge under **Settings → Backup → SFTP → Bridge token** (once; the token is saved). `npm run dev` also works, and additionally downloads TeXlyre's optional assets (TeX Live 2026 engine, draw.io, TikZ editor, ~550 MB).
</details>

## Using it with Compute Canada (Digital Research Alliance of Canada)

This works with the Alliance clusters (for example Fir, Nibi, Narval, Rorqual), including their required Duo MFA. It has been tested on an Alliance cluster with an SSH key plus Duo.

### 1. One-time setup on the Alliance side

- An active Alliance account in [CCDB](https://ccdb.alliancecan.ca).
- **Multifactor authentication (Duo) enrolled.** SSH logins to the clusters ask for it. See [Multifactor authentication](https://docs.alliancecan.ca/wiki/Multifactor_authentication).
- **Your SSH public key added in CCDB**, on the SSH Keys page of your account. See [SSH Keys](https://docs.alliancecan.ca/wiki/SSH_Keys).

### 2. One-time setup on your computer

1. If you don't have a key yet, create one and add the contents of the `.pub` file to CCDB:

   ```bash
   ssh-keygen -t ed25519
   ```

2. Add an entry for each cluster you use to your SSH config: `~/.ssh/config` on macOS/Linux, `C:\Users\<you>\.ssh\config` on Windows. Replace `<username>` with your Alliance username. The login address of each cluster is listed on its page in the Alliance docs.

   ```
   Host fir
       HostName fir.alliancecan.ca
       User <username>
       IdentityFile ~/.ssh/id_ed25519
       IdentitiesOnly yes
   ```

3. Log in once from a terminal, answer Duo, and accept the host key:

   ```bash
   ssh fir
   ```

   This saves the cluster's host key in `known_hosts`. The bridge refuses servers whose host key it hasn't seen before, so this step is required once per cluster.

### 3. Connect from TeXlyre

1. Start TeXlyre with the launcher (see [Quick start](#quick-start)).
2. Create or open a project, then click **Backup ▾ → SFTP → Connect over SFTP**.
3. Enter the host alias, e.g. `fir`, and click **Connect**.
4. The Duo prompt appears **inside TeXlyre** (`Passcode or option (1-1):`). Type `1` for a Duo Push and approve it on your phone, or type a passcode. You have 3 minutes to answer.

After that, syncs, page reloads and switching projects reuse the same login. You'll only be asked for Duo again after 30 minutes without activity, or when the bridge restarts. Background sync never asks for Duo by itself: after a restart it waits until you click **Sync now**.

### 4. Choose the folder

The folder browser starts in your home directory. `projects` and `scratch` there are links to the cluster's shared filesystems, and the browser follows them. Click through to your paper, for example `projects/def-<sponsor>/<username>/my-paper`, then click **Use this folder**.

- **Existing paper on the cluster:** the first sync copies it into the project (skipping `build/`, `.git` and LaTeX temporary files; see Settings → Backup → SFTP → Import exclude patterns). Use a new, empty project for this.
- **New paper:** browse to the parent folder, add the new folder's name to the path in the **Folder** box (e.g. `.../my-new-paper`), and click **Use this folder**. The folder is created and filled with your project files.

Where to keep a paper:

| Location | Backed up | Notes |
| --- | --- | --- |
| Home (`~`) | Yes | Small quota. Fine for a paper. |
| Project (`~/projects/def-<sponsor>/`) | Yes | Shared with your group. Good for co-authored papers. |
| Scratch (`~/scratch`) | **No** | Old files are purged. Don't keep your only copy here. |

Check [Storage and file management](https://docs.alliancecan.ca/wiki/Storage_and_file_management) for current quotas and purge rules.

### 5. Day to day

- **Edit and compile in TeXlyre.** Your changes reach the cluster within a minute, or immediately with **Sync now**. The folder on the cluster is a normal directory, so `latexmk` there still works.
- **Edits made on the cluster** (by you, a co-author, or a script) show up in TeXlyre on the next sync.
- **Both sides edited the same file:** the cluster version wins. Your TeXlyre version is in the project under `.texlyre/sftp-conflicts/<time>/`.
- **Sync now** asks before large deletions, and before a cluster version replaces your edits.

### Tips

- **Compute nodes:** there's no need to connect to them. Home, project and scratch are shared across the cluster, so the login node sees the same files. An SSH alias that reaches compute nodes through `ProxyCommand ssh -W …` won't work here, because that inner `ssh` can't show the Duo prompt.
- **Several clusters:** each one is a separate login with its own Duo approval. Use **Change server**, or the **Recent** buttons, to switch.
- **Terminal commands** such as `ssh`, `scp` or `rsync` are separate logins and ask for Duo on their own. That's expected.

### Troubleshooting

| Message | What to do |
| --- | --- |
| Cannot reach the SFTP bridge | Start TeXlyre with the launcher, or run `node sftp-bridge/bridge.cjs`, and keep that window open. |
| The bridge rejected the token | Open TeXlyre with the launcher (it passes the token), or paste the `token:` line printed by the bridge into Settings → Backup → SFTP. |
| Host key … is not in known_hosts | Run `ssh <alias>` once in a terminal and accept the key. |
| HOST KEY MISMATCH | Stop. Check the Alliance status page or announcements for a host key change before editing `known_hosts`. |
| Authentication failed | Check the key is registered in CCDB, and the `User` / `IdentityFile` lines in your SSH config. Also make sure the Duo request was approved within 3 minutes. |
| Folder … was not found | Click **Change server** and browse to the folder. |
| Auto-sync paused | Many files would be deleted (e.g. a scratch purge). Click **Sync now** to review what would change. |

## Everything else

All other features (real-time collaboration, in-browser LaTeX/Typst compilation, Git backups, plugins) are unchanged from TeXlyre; see the [TeXlyre README](https://github.com/TeXlyre/texlyre#readme) and [docs](https://texlyre.org/docs).

## License

AGPL-3.0, same as TeXlyre. This is a modified version of TeXlyre: the SFTP sync plugin (`extras/backup/sftp/`), the local bridge (`sftp-bridge/`), the launchers, and small supporting changes were added in September 2026. All credit for TeXlyre itself goes to the [TeXlyre authors](https://github.com/TeXlyre/texlyre).
