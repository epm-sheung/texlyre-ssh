// test/e2e.cjs
// End-to-end: spawns bridge.cjs against throwaway ssh2 servers with a
// throwaway ssh config/known_hosts, then drives it over WebSocket exactly
// like the TeXlyre plugin does. Never touches ~/.ssh.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { utils } = require('ssh2');

const { startServer } = require('./sshServer.cjs');

const TOKEN = 'test-token-0123456789';
const PASSPHRASE = 'correct horse';
const SEED = 1234;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Deterministic bytes so runs are comparable.
function prng(seed) {
	let s = seed >>> 0;
	return (n) => {
		const out = Buffer.alloc(n);
		for (let i = 0; i < n; i++) {
			s = (s * 1664525 + 1013904223) >>> 0;
			out[i] = s >>> 24;
		}
		return out;
	};
}

class BridgeClient {
	constructor(url, { origin, onPrompt } = {}) {
		this.url = url;
		this.origin = origin;
		this.onPrompt = onPrompt || (() => null);
		this.pending = new Map();
		this.nextId = 1;
		this.logs = [];
		this.prompts = [];
		this.closeCode = null;
	}

	open() {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(
				this.url,
				this.origin ? { origin: this.origin } : {},
			);
			this.ws = ws;
			ws.on('open', resolve);
			ws.on('unexpected-response', (_req, res) =>
				reject(new Error(`HTTP ${res.statusCode}`)),
			);
			ws.on('error', reject);
			ws.on('close', (code) => {
				this.closeCode = code;
				for (const { reject: rej } of this.pending.values())
					rej({ code: 'CLOSED', closeCode: code });
				this.pending.clear();
			});
			ws.on('message', async (raw) => {
				const msg = JSON.parse(raw.toString());
				if (msg.event === 'log') return this.logs.push(msg);
				if (msg.event === 'auth-prompt') {
					this.prompts.push(msg);
					const responses = await this.onPrompt(msg);
					ws.send(
						JSON.stringify({
							op: 'auth-response',
							promptId: msg.promptId,
							responses,
						}),
					);
					return;
				}
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				msg.ok ? p.resolve(msg.result) : p.reject(msg.error);
			});
		});
	}

	request(op, params = {}) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, op, ...params }));
		});
	}

	close() {
		this.ws?.close();
	}
}

async function mapLimit(items, limit, fn) {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (i < items.length) await fn(items[i++]);
		}),
	);
}

// What the TeXlyre plugin does: manifest -> plan -> put* -> commit.
async function push(client, remoteDir, files, { force = false } = {}) {
	const manifest = [...files].map(([rel, buf]) => ({
		path: `/${rel}`,
		sha256: sha256(buf),
	}));
	const plan = await client.request('plan', { remoteDir, manifest, force });
	await mapLimit(plan.upload, 8, (rel) =>
		client.request('put', {
			planId: plan.planId,
			path: `/${rel}`,
			content: files.get(rel).toString('base64'),
		}),
	);
	const result = await client.request('commit', { planId: plan.planId });
	return { plan, result };
}

async function expectError(promise, code) {
	try {
		await promise;
	} catch (err) {
		assert.equal(
			err.code,
			code,
			`expected ${code}, got ${err.code}: ${err.message}`,
		);
		return err;
	}
	assert.fail(`expected error ${code}, but call succeeded`);
}

function waitForListening(child) {
	return new Promise((resolve, reject) => {
		let out = '';
		child.stdout.on('data', (d) => {
			out += d;
			if (out.includes('token:')) resolve();
		});
		child.on('exit', (code) =>
			reject(new Error(`bridge exited ${code}: ${out}`)),
		);
		setTimeout(() => reject(new Error(`bridge did not start: ${out}`)), 10000);
	});
}

async function main() {
	console.log(
		`seed=${SEED} node=${process.version} platform=${process.platform}`,
	);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'texlyre-sftp-e2e-'));
	const serverRoot = path.join(tmp, 'server-root');
	const remoteHome = path.join(serverRoot, 'home', 'tester');

	const plainKey = utils.generateKeyPairSync('ed25519');
	const encKey = utils.generateKeyPairSync('ed25519', {
		passphrase: PASSPHRASE,
		cipher: 'aes256-ctr',
		rounds: 16,
	});
	fs.writeFileSync(path.join(tmp, 'id_plain'), plainKey.private);
	// Default identity name, for user@host:port targets that match no Host block.
	fs.writeFileSync(path.join(tmp, 'id_ed25519'), plainKey.private);
	fs.writeFileSync(path.join(tmp, 'id_enc'), encKey.private);

	const A = await startServer({
		name: 'A',
		rootDir: serverRoot,
		allowedPublicKey: plainKey.public,
	});
	const M = await startServer({
		name: 'M',
		rootDir: serverRoot,
		allowedPublicKey: plainKey.public,
		mfa: true,
	});
	const T = await startServer({
		name: 'T',
		rootDir: serverRoot,
		allowedPublicKey: plainKey.public,
	});
	const E = await startServer({
		name: 'E',
		rootDir: serverRoot,
		allowedPublicKey: encKey.public,
	});

	const hostEntry = (port) => `[127.0.0.1]:${port}`;
	const hashed = (host) => {
		const salt = crypto.randomBytes(20);
		const hash = crypto.createHmac('sha1', salt).update(host).digest('base64');
		return `|1|${salt.toString('base64')}|${hash}`;
	};
	const line = (hosts, blob) =>
		`${hosts} ssh-ed25519 ${blob.toString('base64')}`;
	fs.writeFileSync(
		path.join(tmp, 'known_hosts'),
		[
			line(hostEntry(A.port), A.hostPublicBlob),
			line(hashed(hostEntry(M.port)), M.hostPublicBlob), // hashed entry path
			line(hostEntry(T.port), T.hostPublicBlob),
			line(hostEntry(E.port), E.hostPublicBlob),
		].join('\n'),
	);
	fs.writeFileSync(path.join(tmp, 'known_hosts_empty'), '');
	fs.writeFileSync(
		path.join(tmp, 'known_hosts_wrong'),
		line(hostEntry(T.port), A.hostPublicBlob),
	);

	const kh = (f) =>
		`  UserKnownHostsFile "${path.join(tmp, f).replace(/\\/g, '/')}"`;
	const id = (f) => `  IdentityFile "${path.join(tmp, f).replace(/\\/g, '/')}"`;
	const nc = path.join(__dirname, 'nc.cjs').replace(/\\/g, '/');
	const host = (alias, port, ...extra) =>
		[
			`Host ${alias}`,
			'  HostName 127.0.0.1',
			`  Port ${port}`,
			'  User tester',
			...extra,
		].join('\n');
	fs.writeFileSync(
		path.join(tmp, 'ssh_config'),
		[
			host('testa', A.port, id('id_plain'), kh('known_hosts')),
			host('testmfa', M.port, id('id_plain'), kh('known_hosts')),
			host(
				'testjump',
				T.port,
				id('id_plain'),
				kh('known_hosts'),
				'  ProxyJump testa',
			),
			host(
				'testpc',
				T.port,
				id('id_plain'),
				kh('known_hosts'),
				`  ProxyCommand node "${nc}" %h %p`,
			),
			host('testenc', E.port, id('id_enc'), kh('known_hosts')),
			host('testunknown', T.port, id('id_plain'), kh('known_hosts_empty')),
			host('testmismatch', T.port, id('id_plain'), kh('known_hosts_wrong')),
			host(
				'testacceptnew',
				T.port,
				id('id_plain'),
				kh('known_hosts_empty'),
				'  StrictHostKeyChecking accept-new',
			),
			'Host *.wild\n  User nobody',
		].join('\n\n'),
	);

	const wsPort = 17000 + Math.floor(Math.random() * 2000);
	const bridge = spawn(
		process.execPath,
		[path.join(__dirname, '..', 'bridge.cjs')],
		{
			env: {
				...process.env,
				SSH_CONFIG: path.join(tmp, 'ssh_config'),
				WS_PORT: String(wsPort),
				BRIDGE_TOKEN: TOKEN,
				SFTP_BRIDGE_NO_AGENT: '1',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	let bridgeLog = '';
	bridge.stdout.on('data', (d) => {
		bridgeLog += d;
	});
	bridge.stderr.on('data', (d) => {
		bridgeLog += d;
	});
	await waitForListening(bridge);
	const url = `ws://127.0.0.1:${wsPort}`;

	const results = [];
	const step = async (name, fn) => {
		const t0 = performance.now();
		try {
			const note = await fn();
			results.push({
				name,
				ok: true,
				ms: performance.now() - t0,
				note: note || '',
			});
		} catch (err) {
			results.push({
				name,
				ok: false,
				ms: performance.now() - t0,
				note: err.stack || err.message || JSON.stringify(err),
			});
		}
	};
	const authed = async (opts) => {
		const c = new BridgeClient(url, opts);
		await c.open();
		await c.request('hello', { token: TOKEN });
		return c;
	};

	// ---------------------------------------------------------------- security
	await step('reject disallowed Origin (403)', async () => {
		await assert.rejects(
			new BridgeClient(url, { origin: 'https://evil.example' }).open(),
			/HTTP 403/,
		);
	});
	await step('reject wrong token + close 4401', async () => {
		const c = new BridgeClient(url);
		await c.open();
		await expectError(c.request('hello', { token: 'nope' }), 'BAD_TOKEN');
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(c.closeCode, 4401);
	});
	await step('reject ops before hello', async () => {
		const c = new BridgeClient(url);
		await c.open();
		await expectError(c.request('hosts'), 'NOT_AUTHENTICATED');
	});
	await step('allowed Origin http://localhost:5173 + hosts', async () => {
		const c = await authed({ origin: 'http://localhost:5173' });
		const { hosts } = await c.request('hosts');
		c.close();
		assert.ok(hosts.includes('testa') && !hosts.some((h) => h.includes('*')));
		return `${hosts.length} aliases, wildcard excluded`;
	});
	await step('reject shell-ish alias', async () => {
		const c = await authed();
		await expectError(c.request('connect', { host: 'x;calc' }), 'BAD_HOST');
		c.close();
	});

	// ---------------------------------------------------------------- push flow
	const rand = prng(SEED);
	const project = new Map([
		[
			'main.tex',
			Buffer.from(
				'\\documentclass{article}\n\\begin{document}\nHello SFTP\n\\input{chapters/intro}\n\\end{document}\n',
			),
		],
		['refs.bib', Buffer.from('@article{a, title={A}, year={2026}}\n')],
		['figures/plot.png', rand(200 * 1024)],
		['chapters/intro.tex', Buffer.from('Intro text.\n')],
		['chapters/deep/nested/appendix.tex', Buffer.from('Appendix.\n')],
	]);
	const REMOTE = 'papers/demo';
	const remotePath = (rel) =>
		path.join(remoteHome, 'papers', 'demo', ...rel.split('/'));
	const c = await authed();

	await step('connect user@host:port (no ssh config entry)', async () => {
		const d = await authed();
		const r = await d.request('connect', {
			host: `tester@127.0.0.1:${A.port}`,
		});
		await expectError(
			d.request('connect', { host: 'tester@127.0.0.1:99999' }),
			'BAD_HOST',
		);
		await expectError(
			d.request('connect', { host: 'a;b@127.0.0.1' }),
			'BAD_HOST',
		);
		await expectError(
			d.request('connect', { host: 'tester@-oProxyCommand=x' }),
			'BAD_HOST',
		);
		d.close();
		assert.equal(r.user, 'tester');
		return `${r.user}@${r.hostName}:${r.port} home=${r.home}`;
	});
	await step('connect testa (publickey)', async () => {
		const r = await c.request('connect', { host: 'testa' });
		assert.equal(r.home, '/home/tester');
		return `home=${r.home}`;
	});
	await step('first push creates tree', async () => {
		const { plan, result } = await push(c, REMOTE, project);
		assert.equal(plan.upload.length, 5);
		for (const [rel, buf] of project)
			assert.ok(fs.readFileSync(remotePath(rel)).equals(buf), rel);
		const state = JSON.parse(
			fs.readFileSync(remotePath('.texlyre-sync.json'), 'utf8'),
		);
		assert.equal(Object.keys(state.files).length, 5);
		return `uploaded=${result.uploaded} bytes=${result.bytes} remoteDir=${result.remoteDir}`;
	});
	await step('second push is a no-op', async () => {
		const { plan, result } = await push(c, REMOTE, project);
		assert.equal(plan.upload.length, 0);
		assert.equal(result.unchanged, 5);
		return `unchanged=${result.unchanged}`;
	});
	await step('local edit uploads 1 file', async () => {
		project.set(
			'main.tex',
			Buffer.from(`${project.get('main.tex')}% edited\n`),
		);
		const { plan } = await push(c, REMOTE, project);
		assert.deepEqual(plan.upload, ['main.tex']);
		assert.ok(
			fs.readFileSync(remotePath('main.tex'), 'utf8').includes('% edited'),
		);
	});
	await step('server-side edit is preserved (local unchanged)', async () => {
		fs.appendFileSync(remotePath('refs.bib'), '% edited on cluster\n');
		const { plan } = await push(c, REMOTE, project);
		assert.deepEqual(plan.upload, []);
		assert.deepEqual(plan.remoteEdited, ['refs.bib']);
		assert.ok(
			fs
				.readFileSync(remotePath('refs.bib'), 'utf8')
				.includes('edited on cluster'),
		);
	});
	await step('both sides edited -> conflict, not overwritten', async () => {
		project.set(
			'refs.bib',
			Buffer.from('@article{b, title={B}, year={2026}}\n'),
		);
		const { plan } = await push(c, REMOTE, project);
		assert.deepEqual(plan.conflicts, [
			{ path: 'refs.bib', reason: 'remote-modified' },
		]);
		assert.ok(
			fs
				.readFileSync(remotePath('refs.bib'), 'utf8')
				.includes('edited on cluster'),
		);
	});
	await step('force overwrites the conflict', async () => {
		const { plan } = await push(c, REMOTE, project, { force: true });
		assert.deepEqual(plan.upload, ['refs.bib']);
		assert.ok(
			fs.readFileSync(remotePath('refs.bib')).equals(project.get('refs.bib')),
		);
	});
	await step('untracked server file is not clobbered', async () => {
		fs.writeFileSync(remotePath('notes.txt'), 'cluster notes\n');
		project.set('notes.txt', Buffer.from('local notes\n'));
		const { plan } = await push(c, REMOTE, project);
		assert.deepEqual(plan.conflicts, [
			{ path: 'notes.txt', reason: 'untracked-remote-file' },
		]);
		assert.equal(
			fs.readFileSync(remotePath('notes.txt'), 'utf8'),
			'cluster notes\n',
		);
		project.delete('notes.txt');
	});
	await step('local delete removes only tracked files', async () => {
		fs.writeFileSync(remotePath('main.pdf'), 'build output');
		project.delete('chapters/deep/nested/appendix.tex');
		const { plan, result } = await push(c, REMOTE, project);
		assert.deepEqual(plan.delete, ['chapters/deep/nested/appendix.tex']);
		assert.equal(result.deleted, 1);
		assert.ok(!fs.existsSync(remotePath('chapters/deep/nested/appendix.tex')));
		assert.ok(
			fs.existsSync(remotePath('main.pdf')),
			'untracked build output must survive',
		);
		assert.ok(
			fs.existsSync(remotePath('notes.txt')),
			'untracked server file must survive',
		);
	});
	await step('reject path traversal', async () => {
		await expectError(
			c.request('plan', {
				remoteDir: REMOTE,
				manifest: [
					{ path: '/../escape.tex', sha256: sha256(Buffer.from('x')) },
				],
			}),
			'BAD_PATH',
		);
		await expectError(
			c.request('plan', {
				remoteDir: REMOTE,
				manifest: [{ path: '/a\\b.tex', sha256: sha256(Buffer.from('x')) }],
			}),
			'BAD_PATH',
		);
		await expectError(
			c.request('plan', { remoteDir: '/', manifest: [] }),
			'BAD_PATH',
		);
	});
	await step('reject content/hash mismatch and unplanned put', async () => {
		const plan = await c.request('plan', {
			remoteDir: 'papers/other',
			manifest: [{ path: '/a.tex', sha256: sha256(Buffer.from('real')) }],
		});
		await expectError(
			c.request('put', {
				planId: plan.planId,
				path: '/a.tex',
				content: Buffer.from('fake').toString('base64'),
			}),
			'HASH_MISMATCH',
		);
		await expectError(
			c.request('put', { planId: plan.planId, path: '/b.tex', content: '' }),
			'NOT_PLANNED',
		);
		const err = await expectError(
			c.request('commit', { planId: plan.planId }),
			'MISSING_UPLOADS',
		);
		assert.deepEqual(err.details.missing, ['a.tex']);
	});
	await step('throughput: 200 files x 100 KB', async () => {
		const big = new Map();
		for (let i = 0; i < 200; i++)
			big.set(`data/f${String(i).padStart(3, '0')}.bin`, rand(100 * 1024));
		const t0 = performance.now();
		const { result } = await push(c, 'papers/big', big);
		const secs = (performance.now() - t0) / 1000;
		const t1 = performance.now();
		const again = await push(c, 'papers/big', big);
		const noop = performance.now() - t1;
		assert.equal(result.uploaded, 200);
		assert.equal(again.plan.upload.length, 0);
		return `${(result.bytes / 1e6).toFixed(1)} MB in ${secs.toFixed(2)} s = ${(result.bytes / 1e6 / secs).toFixed(1)} MB/s; no-op re-push ${noop.toFixed(0)} ms`;
	});

	// ------------------------------------------- existing folder: import/adopt
	// Mimics a paper that already lives in a folder on the server.
	const EXIST = 'scratch/paper';
	const existPath = (rel) =>
		path.join(remoteHome, 'scratch', 'paper', ...rel.split('/'));
	const serverTree = {
		'main.tex':
			'\\documentclass{article}\n\\input{header}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n',
		'header.tex': '\\usepackage{amsmath}\n',
		'refs.bib': '@inproceedings{x, title={X}, year={2025}}\n',
		'chapters/intro.tex': 'Intro.\n',
		'figs/teaser.png': rand(50 * 1024),
		'main.aux': 'aux junk',
		'build/main.pdf': 'pdf bytes',
		'.git/config': '[core]\n',
	};
	for (const [rel, content] of Object.entries(serverTree)) {
		fs.mkdirSync(path.dirname(existPath(rel)), { recursive: true });
		fs.writeFileSync(existPath(rel), content);
	}
	const EXCLUDE = ['build', '.git', '*.aux', '*.log'];
	let imported;

	await step('list existing folder with excludes', async () => {
		const r = await c.request('list', { remoteDir: EXIST, exclude: EXCLUDE });
		assert.deepEqual(
			r.files.map((f) => f.path),
			[
				'chapters/intro.tex',
				'figs/teaser.png',
				'header.tex',
				'main.tex',
				'refs.bib',
			],
		);
		assert.deepEqual(r.skipped.excluded.sort(), ['.git', 'build', 'main.aux']);
		return `${r.files.length} files, ${r.totalBytes} B; excluded ${r.skipped.excluded.join(', ')}`;
	});
	await step('get returns exact bytes', async () => {
		imported = new Map();
		const { files } = await c.request('list', {
			remoteDir: EXIST,
			exclude: EXCLUDE,
		});
		for (const f of files) {
			const r = await c.request('get', {
				remoteDir: EXIST,
				path: `/${f.path}`,
			});
			const buf = Buffer.from(r.content, 'base64');
			assert.equal(sha256(buf), r.sha256);
			assert.ok(buf.equals(fs.readFileSync(existPath(f.path))), f.path);
			imported.set(f.path, buf);
		}
		await expectError(
			c.request('get', { remoteDir: EXIST, path: '/../../etc/passwd' }),
			'BAD_PATH',
		);
		await expectError(
			c.request('get', { remoteDir: EXIST, path: '/chapters' }),
			'NOT_A_FILE',
		);
	});
	await step('first push after import adopts, uploads nothing', async () => {
		const { plan, result } = await push(c, EXIST, imported);
		assert.equal(plan.upload.length, 0);
		assert.equal(plan.adopted, 5);
		assert.deepEqual(plan.conflicts, []);
		assert.ok(
			fs.existsSync(existPath('build/main.pdf')) &&
				fs.existsSync(existPath('main.aux')),
		);
		return `adopted=${result.adopted} uploaded=${result.uploaded}`;
	});
	await step('edit after import uploads just that file', async () => {
		imported.set(
			'chapters/intro.tex',
			Buffer.from('Intro, edited in TeXlyre.\n'),
		);
		const { plan } = await push(c, EXIST, imported);
		assert.deepEqual(plan.upload, ['chapters/intro.tex']);
		assert.equal(
			fs.readFileSync(existPath('chapters/intro.tex'), 'utf8'),
			'Intro, edited in TeXlyre.\n',
		);
	});
	await step(
		'untracked server file with different content still conflicts',
		async () => {
			const other = new Map([['main.tex', Buffer.from('totally different\n')]]);
			fs.mkdirSync(path.join(remoteHome, 'scratch', 'other'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(remoteHome, 'scratch', 'other', 'main.tex'),
				'server version\n',
			);
			const r = await push(c, 'scratch/other', other);
			assert.deepEqual(r.plan.conflicts, [
				{ path: 'main.tex', reason: 'untracked-remote-file' },
			]);
			assert.equal(
				fs.readFileSync(
					path.join(remoteHome, 'scratch', 'other', 'main.tex'),
					'utf8',
				),
				'server version\n',
			);
		},
	);
	await step('folder browser (dirs)', async () => {
		const home = await c.request('dirs', { remoteDir: '~' });
		assert.equal(home.path, '/home/tester');
		assert.equal(home.parent, '/home');
		assert.ok(
			['papers', 'scratch'].every((n) => home.dirs.some((d) => d.name === n)),
		);
		const sub = await c.request('dirs', { remoteDir: 'scratch' });
		assert.deepEqual(
			sub.dirs.map((d) => d.name),
			['other', 'paper'],
		);
		const paper = await c.request('dirs', {
			remoteDir: '/home/tester/scratch/paper',
		});
		assert.deepEqual(
			paper.dirs.map((d) => d.name),
			['.git', 'build', 'chapters', 'figs'],
		);
		assert.equal(paper.files, 5); // main.tex, refs.bib, main.aux, header.tex, .texlyre-sync.json
		await expectError(
			c.request('dirs', { remoteDir: 'nope/nothing' }),
			'NOT_FOUND',
		);
		await expectError(
			c.request('dirs', { remoteDir: 'scratch/paper/main.tex' }),
			'NOT_A_DIRECTORY',
		);
		return `~ -> ${home.dirs.length} dirs; scratch/paper -> ${paper.dirs.length} dirs, ${paper.files} files`;
	});
	await step('touch-only mtime drift is not a conflict', async () => {
		const future = new Date(Date.now() + 3600e3);
		fs.utimesSync(existPath('refs.bib'), future, future); // content unchanged
		fs.utimesSync(existPath('header.tex'), future, future);
		imported.set(
			'refs.bib',
			Buffer.from('@inproceedings{x, title={X2}, year={2025}}\n'),
		);
		const { plan } = await push(c, EXIST, imported);
		assert.deepEqual(plan.upload, ['refs.bib']);
		assert.deepEqual(plan.conflicts, []);
		assert.equal(plan.adopted, 1); // header.tex re-tracked with its new mtime
		const again = await push(c, EXIST, imported);
		assert.equal(
			again.plan.upload.length +
				again.plan.adopted +
				again.plan.conflicts.length,
			0,
		);
	});
	c.close();

	// ---------------------------------------------------------------- auth paths
	await step('MFA keyboard-interactive (Duo-style) accepted', async () => {
		const m = await authed({ onPrompt: () => ['1'] });
		await m.request('connect', { host: 'testmfa' });
		m.close();
		assert.equal(m.prompts.length, 1);
		return `prompt="${m.prompts[0].prompts[0].prompt.trim()}" title="${m.prompts[0].title}"`;
	});
	await step(
		'MFA session survives browser reconnect (no 2nd prompt)',
		async () => {
			const before = M.events.mfaPrompts;
			const m2 = await authed({ onPrompt: () => ['1'] });
			const r = await m2.request('connect', { host: 'testmfa' });
			m2.close();
			assert.equal(r.reused, true);
			assert.equal(m2.prompts.length, 0);
			assert.equal(M.events.mfaPrompts, before);
			// Explicit disconnect ends the pooled session; the next login prompts again.
			const m3 = await authed({ onPrompt: () => ['1'] });
			await m3.request('connect', { host: 'testmfa' });
			await m3.request('disconnect');
			await m3.request('connect', { host: 'testmfa' });
			await m3.request('disconnect');
			m3.close();
			assert.equal(m3.prompts.length, 1);
			return `reconnect reused session (0 prompts); after disconnect: ${m3.prompts.length} prompt`;
		},
	);
	await step('MFA wrong answer -> AUTH_FAILED', async () => {
		const m = await authed({ onPrompt: () => ['2'] });
		const err = await expectError(
			m.request('connect', { host: 'testmfa' }),
			'AUTH_FAILED',
		);
		m.close();
		return err.message;
	});
	await step('encrypted key -> passphrase prompt', async () => {
		const m = await authed({
			onPrompt: (p) => (p.title.startsWith('Passphrase') ? [PASSPHRASE] : null),
		});
		await m.request('connect', { host: 'testenc' });
		m.close();
		return `prompt title="${path.basename(m.prompts[0].title)}"`;
	});
	await step('ProxyJump via testa', async () => {
		const before = A.events.forwards.length;
		const m = await authed();
		await m.request('connect', { host: 'testjump' });
		const { planId } = await m.request('plan', {
			remoteDir: 'papers/jump',
			manifest: [],
		});
		await m.request('commit', { planId });
		m.close();
		assert.deepEqual(A.events.forwards.slice(before), [`127.0.0.1:${T.port}`]);
		return `jump host forwarded to 127.0.0.1:${T.port}`;
	});
	await step('ProxyCommand (node nc.cjs %h %p)', async () => {
		const m = await authed();
		const r = await m.request('connect', { host: 'testpc' });
		m.close();
		return `home=${r.home}`;
	});
	await step('unknown host key -> HOST_KEY_UNKNOWN', async () => {
		const m = await authed();
		const err = await expectError(
			m.request('connect', { host: 'testunknown' }),
			'HOST_KEY_UNKNOWN',
		);
		m.close();
		return err.message;
	});
	await step('changed host key -> HOST_KEY_MISMATCH', async () => {
		const m = await authed();
		const err = await expectError(
			m.request('connect', { host: 'testmismatch' }),
			'HOST_KEY_MISMATCH',
		);
		m.close();
		return err.message.slice(0, 90);
	});
	await step('StrictHostKeyChecking accept-new', async () => {
		const m = await authed();
		await m.request('connect', { host: 'testacceptnew' });
		m.close();
		return m.logs.find((l) => l.message.includes('accepting unknown'))?.message;
	});

	await step(
		'token persists across restarts, --new-token rotates',
		async () => {
			const stateDir = path.join(tmp, 'bridge-state');
			const runOnce = (args = []) =>
				new Promise((resolve, reject) => {
					const env = {
						...process.env,
						SSH_CONFIG: path.join(tmp, 'ssh_config'),
						SFTP_BRIDGE_HOME: stateDir,
						WS_PORT: '0',
					};
					delete env.BRIDGE_TOKEN;
					const b = spawn(
						process.execPath,
						[path.join(__dirname, '..', 'bridge.cjs'), ...args],
						{ env, stdio: ['ignore', 'pipe', 'pipe'] },
					);
					let out = '';
					b.stdout.on('data', (d) => {
						out += d;
						// Wait for the whole line: a stdout chunk can end mid-token.
						const m = /token: (\S+) +\(from/.exec(out);
						if (m) {
							b.kill();
							resolve(m[1]);
						}
					});
					b.on('exit', () => reject(new Error(`bridge exited: ${out}`)));
				});
			const t1 = await runOnce();
			const t2 = await runOnce();
			const t3 = await runOnce(['--new-token']);
			const t4 = await runOnce();
			assert.equal(t1, t2);
			assert.notEqual(t3, t1);
			assert.equal(t4, t3);
			assert.equal(
				fs.readFileSync(path.join(stateDir, 'token'), 'utf8').trim(),
				t3,
			);
			return 'same token on restart; rotated once with --new-token';
		},
	);

	bridge.kill();
	for (const s of [A, M, T, E]) s.close();
	fs.rmSync(tmp, { recursive: true, force: true });

	console.log('');
	for (const r of results) {
		console.log(
			`${r.ok ? 'PASS' : 'FAIL'}  ${r.ms.toFixed(0).padStart(6)} ms  ${r.name}${r.note ? `\n                   ${r.note}` : ''}`,
		);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(`\n${results.length - failed}/${results.length} passed`);
	if (failed) {
		console.log(`\n--- bridge log ---\n${bridgeLog}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
