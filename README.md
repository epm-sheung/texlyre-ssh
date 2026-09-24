# TeXlyre + SSH

Modified based on **[TeXlyre](https://github.com/TeXlyre/texlyre)**, the local-first LaTeX & Typst editor. This version adds **SSH/SFTP support**: open a paper that lives on any SSH server (an HPC cluster, a lab machine, a VPS), edit and compile it in the browser, and push your changes back.

## What's new

- **Import from server**: copy a folder from any SSH host into a TeXlyre project.
- **Push via SFTP**: upload only the files you changed.
- **Safe by default**: files edited on the server are never overwritten (unless you Force push), and nothing TeXlyre didn't create is ever deleted, so build outputs next to your paper are left alone.
- **Works like `ssh`**: uses your `~/.ssh/config`, keys, `known_hosts`, ProxyJump/ProxyCommand, key passphrases, and MFA/Duo prompts. You can also type `user@host[:port]` directly.
- **Folder browser and recent servers**: click through folders on the server instead of typing paths; switch servers in one click.
- **One login per session**: MFA is asked once; the connection is reused until it's idle for 30 minutes.

Browsers can't open SSH connections, so a small local helper, [`sftp-bridge/`](sftp-bridge/README.md), holds the connection on your machine. Your keys never leave `~/.ssh`.

## Quick start

Requires [Node.js](https://nodejs.org/) 20+. Use two terminals and keep both open.

Terminal 1, TeXlyre:

```bash
npm install
npm run dev
```

Terminal 2, the bridge:

```bash
cd sftp-bridge
npm install
node bridge.cjs
```

1. Open `http://localhost:5173/texlyre/`, sign up (the account is local to your browser), and paste the `token:` printed by the bridge under **Settings → Backup → SFTP → Bridge token**. The token is saved, so this is a one-time step.
2. Open a project, click **Backup ▾ → SFTP → Connect over SFTP**, enter a host, then browse to the folder and click **Use this folder**.
3. **Import from server** brings the files in; **Push via SFTP** sends your changes back.

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

1. Start TeXlyre and the bridge (see [Quick start](#quick-start)).
2. Create or open a project, then click **Backup ▾ → SFTP → Connect over SFTP**.
3. Enter the host alias, e.g. `fir`, and click **Connect**.
4. The Duo prompt appears **inside TeXlyre** (`Passcode or option (1-1):`). Type `1` for a Duo Push and approve it on your phone, or type a passcode. You have 3 minutes to answer.

After that, pushes, imports, page reloads and switching projects reuse the same login. You'll only be asked for Duo again after 30 minutes without activity, or when you restart the bridge.

### 4. Choose the folder

The folder browser starts in your home directory. `projects` and `scratch` there are links to the cluster's shared filesystems, and the browser follows them. Click through to your paper, for example `projects/def-<sponsor>/<username>/my-paper`, then click **Use this folder**.

Where to keep a paper:

| Location | Backed up | Notes |
| --- | --- | --- |
| Home (`~`) | Yes | Small quota. Fine for a paper. |
| Project (`~/projects/def-<sponsor>/`) | Yes | Shared with your group. Good for co-authored papers. |
| Scratch (`~/scratch`) | **No** | Old files are purged. Don't keep your only copy here. |

Check [Storage and file management](https://docs.alliancecan.ca/wiki/Storage_and_file_management) for current quotas and purge rules.

### 5. Import, edit, push

- **Existing paper on the cluster:** click **Import from server**. It skips `build/`, `.git`, and LaTeX temporary files (`.aux`, `.log`, …); change this under Settings → Backup → SFTP → Import exclude patterns. TeXlyre records the server state right after the import, so the first push uploads nothing.
- **New paper:** in step 4, browse to the parent folder, add the new folder's name to the path in the **Folder** box (e.g. `.../my-new-paper`), and click **Use this folder**. Then skip the import and click **Push via SFTP**; the folder is created and filled with your project files.
- **Day to day:** edit and compile in TeXlyre, then **Push via SFTP**. Only changed files are uploaded. You can still compile on the cluster in the same folder, since it's a normal directory there.

### Tips

- **Edits made on the cluster** (by you, a co-author, or a script) are never overwritten; TeXlyre lists them as conflicts. To bring them into TeXlyre, push first, then click **Import from server** again. The import replaces the local copies of same-named files.
- **Compute nodes:** there's no need to connect to them. Home, project and scratch are shared across the cluster, so the login node sees the same files. An SSH alias that reaches compute nodes through `ProxyCommand ssh -W …` won't work here, because that inner `ssh` can't show the Duo prompt.
- **Several clusters:** each one is a separate login with its own Duo approval. Use **Change server**, or the **Recent** buttons, to switch.
- **Terminal commands** such as `ssh`, `scp` or `rsync` are separate logins and ask for Duo on their own. That's expected.

### Troubleshooting

| Message | What to do |
| --- | --- |
| Cannot reach the SFTP bridge | Start the bridge (`node bridge.cjs` in `sftp-bridge/`) and keep its terminal open. |
| The bridge rejected the token | Paste the `token:` line printed by the bridge into Settings → Backup → SFTP. |
| Host key … is not in known_hosts | Run `ssh <alias>` once in a terminal and accept the key. |
| HOST KEY MISMATCH | Stop. Check the Alliance status page or announcements for a host key change before editing `known_hosts`. |
| Authentication failed | Check the key is registered in CCDB, and the `User` / `IdentityFile` lines in your SSH config. Also make sure the Duo request was approved within 3 minutes. |
| Folder … was not found | Click **Change server** and browse to the folder. |

## Everything else

All other features (real-time collaboration, in-browser LaTeX/Typst compilation, Git backups, plugins) are unchanged from TeXlyre; see the [TeXlyre README](https://github.com/TeXlyre/texlyre#readme) and [docs](https://texlyre.org/docs).

## License

AGPL-3.0, same as TeXlyre. This is a modified version of TeXlyre: the SFTP backup plugin (`extras/backup/sftp/`), the local bridge (`sftp-bridge/`), and small supporting changes were added in September 2026. All credit for TeXlyre itself goes to the [TeXlyre authors](https://github.com/TeXlyre/texlyre).
