#!/usr/bin/env node
// bridge.cjs
// Local WebSocket <-> SSH/SFTP bridge for the TeXlyre SFTP backup plugin.
//
// Browsers cannot open TCP sockets, so TeXlyre talks JSON over
// ws://127.0.0.1:${WS_PORT} to this process, which owns the SSH connection
// and reads ~/.ssh/config, keys and known_hosts like OpenSSH does.
//
// Security model: loopback only, Origin allowlist (any web page can try to
// open ws://127.0.0.1), and a token (saved in the user's profile) that must
// be sent in the first message.
//
// Protocol: request {id, op, ...} -> response {id, ok, result | error}.
// Server-initiated: {event: 'auth-prompt', promptId, title, instructions,
// prompts: [{prompt, echo}]}, answered by {op: 'auth-response', promptId,
// responses: [...] | null}; {event: 'log', level, message}.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const { BridgeError, openSession } = require('./lib/connect.cjs');
const sshConfig = require('./lib/sshConfig.cjs');
const sync = require('./lib/sftpSync.cjs');

const VERSION = '0.1.0';

const CONFIG = {
	host: process.env.WS_HOST || '127.0.0.1',
	port: Number(process.env.WS_PORT || 7050),
	token: null, // set in main(): BRIDGE_TOKEN, else the saved token file
	stateDir:
		process.env.SFTP_BRIDGE_HOME ||
		path.join(os.homedir(), '.texlyre-sftp-bridge'),
	allowedOrigins: (
		process.env.ALLOWED_ORIGINS ||
		'http://localhost:5173,https://localhost:5173,http://127.0.0.1:5173,https://texlyre.org,https://texlyre.github.io'
	)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean),
	// Dev only: skip the token check (Origin allowlist still applies).
	allowNoToken: process.env.SFTP_BRIDGE_ALLOW_NO_TOKEN === '1',
	maxPayloadMB: Number(process.env.MAX_PAYLOAD_MB || 64),
	helloTimeoutMs: 5000,
	promptTimeoutMs: 180000,
};

const ts = () => new Date().toISOString().slice(11, 23);
const log = (conn, level, message) => {
	console.log(`${ts()} [#${conn}] ${level.padEnd(4)} ${message}`);
};

function tokenOk(given) {
	if (CONFIG.allowNoToken) return true;
	const a = Buffer.from(String(given || ''));
	const b = Buffer.from(CONFIG.token);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function errorPayload(err) {
	if (err instanceof BridgeError) {
		return { code: err.code, message: err.message, details: err.details };
	}
	return {
		code: err.code ? `SFTP_${err.code}` : 'INTERNAL',
		message: err.message || String(err),
	};
}

let connCounter = 0;

// SSH sessions outlive browser connections (page reloads, a second tab), so
// one MFA approval covers the whole bridge run. Keyed by host spec; closed on
// explicit disconnect or after SESSION_IDLE_MIN minutes without use.
const sessions = new Map(); // host -> { session, timer }
const connecting = new Map(); // host -> Promise<entry>, while logging in
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MIN || 30) * 60000;

function touchSession(host) {
	const entry = sessions.get(host);
	if (!entry) return;
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => closeSession(host, 'idle'), SESSION_IDLE_MS);
	entry.timer.unref();
}

function closeSession(host, why) {
	const entry = sessions.get(host);
	if (!entry) return;
	sessions.delete(host);
	clearTimeout(entry.timer);
	entry.session.close();
	console.log(`${ts()} [--] info closed SSH session ${host} (${why})`);
}

function handleConnection(ws, req) {
	const conn = ++connCounter;
	const state = {
		authed: false,
		sessionHost: null,
		plans: new Map(),
		prompts: new Map(),
	};
	log(conn, 'info', `open from origin=${req.headers.origin || '(none)'}`);

	const send = (msg) => {
		if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
	};
	const clientLog = (level, message) => {
		log(conn, level, message);
		send({ event: 'log', level, message });
	};

	const prompt = ({ title, instructions, prompts }) =>
		new Promise((resolve, reject) => {
			const promptId = crypto.randomUUID();
			const timer = setTimeout(() => {
				state.prompts.delete(promptId);
				reject(
					new BridgeError(
						'PROMPT_TIMEOUT',
						'No answer to authentication prompt',
					),
				);
			}, CONFIG.promptTimeoutMs);
			state.prompts.set(promptId, { resolve, timer });
			// Never log prompt answers; prompt text only.
			log(
				conn,
				'info',
				`auth-prompt: ${title} [${prompts.map((p) => p.prompt.trim()).join(' | ')}]`,
			);
			send({
				event: 'auth-prompt',
				promptId,
				title,
				instructions: instructions || '',
				prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
			});
		});

	const helloTimer = setTimeout(() => {
		if (!state.authed) ws.close(4401, 'hello timeout');
	}, CONFIG.helloTimeoutMs);

	const requireSession = () => {
		const entry = state.sessionHost && sessions.get(state.sessionHost);
		if (!entry) throw new BridgeError('NOT_CONNECTED', 'Call connect first');
		touchSession(state.sessionHost);
		return entry.session;
	};

	const ops = {
		hello: async ({ token }) => {
			if (!tokenOk(token)) {
				setTimeout(() => ws.close(4401, 'bad token'), 10);
				throw new BridgeError('BAD_TOKEN', 'Bridge token does not match');
			}
			state.authed = true;
			clearTimeout(helloTimer);
			return { version: VERSION, sshConfig: sshConfig.configPath() };
		},

		ping: async () => ({
			pong: Date.now(),
			connected: !!(state.sessionHost && sessions.has(state.sessionHost)),
			host: state.sessionHost,
		}),

		hosts: async () => ({ hosts: sshConfig.listHosts() }),

		connect: async ({ host }) => {
			let entry = sessions.get(host);
			const reused = !!entry;
			if (!entry) {
				// A second client asking for the same host while the first is
				// still in MFA waits for that login instead of starting another.
				if (!connecting.has(host)) {
					connecting.set(
						host,
						openSession(host, { prompt, log: clientLog })
							.then((session) => {
								const e = { session, timer: null };
								sessions.set(host, e);
								session.client.on('close', () => {
									if (sessions.get(host) !== e) return;
									sessions.delete(host);
									clearTimeout(e.timer);
									console.log(
										`${ts()} [--] info SSH session ${host} closed by server/network`,
									);
								});
								return e;
							})
							.finally(() => connecting.delete(host)),
					);
				}
				entry = await connecting.get(host);
			}
			state.sessionHost = host;
			touchSession(host);
			const { user, hostName, port } = entry.session.cfg;
			return { host, user, hostName, port, home: entry.session.home, reused };
		},

		disconnect: async () => {
			if (state.sessionHost) closeSession(state.sessionHost, 'disconnect');
			state.sessionHost = null;
			return {};
		},

		plan: async ({ remoteDir, manifest, force }) => {
			const session = requireSession();
			const dir = sync.resolveRemoteDir(session.home, remoteDir);
			const planned = await sync.plan(session.sftp, dir, manifest, {
				force: !!force,
			});
			const planId = crypto.randomUUID();
			state.plans.set(planId, {
				dir,
				planned,
				uploadSet: new Set(planned.upload),
				uploaded: new Map(),
				dirCache: new Map(),
			});
			return {
				planId,
				remoteDir: dir,
				upload: planned.upload,
				delete: planned.delete,
				unchanged: planned.unchanged.length,
				adopted: planned.adopted.size,
				remoteEdited: planned.remoteEdited,
				conflicts: planned.conflicts,
			};
		},

		dirs: async ({ remoteDir }) => {
			const session = requireSession();
			return sync.listDirs(session.sftp, session.home, remoteDir);
		},

		list: async ({ remoteDir, exclude }) => {
			const session = requireSession();
			const dir = sync.resolveRemoteDir(session.home, remoteDir);
			return {
				remoteDir: dir,
				...(await sync.listTree(session.sftp, dir, exclude)),
			};
		},

		get: async ({ remoteDir, path: filePath }) => {
			const session = requireSession();
			const dir = sync.resolveRemoteDir(session.home, remoteDir);
			return sync.getFile(session.sftp, dir, filePath);
		},

		put: async ({ planId, path: filePath, content }) => {
			const session = requireSession();
			const p = state.plans.get(planId);
			if (!p) throw new BridgeError('BAD_PLAN', 'Unknown or finished plan');
			const rel = sync.cleanRelPath(filePath);
			if (!p.uploadSet.has(rel))
				throw new BridgeError(
					'NOT_PLANNED',
					`${rel} is not in the upload plan`,
				);
			const buf = Buffer.from(String(content || ''), 'base64');
			if (sync.sha256(buf) !== p.planned.local.get(rel)) {
				throw new BridgeError(
					'HASH_MISMATCH',
					`Content of ${rel} does not match its manifest hash`,
				);
			}
			const st = await sync.putFile(session.sftp, p.dir, rel, buf, p.dirCache);
			p.uploaded.set(rel, st);
			return { path: rel, size: st.size };
		},

		// Is there already a logged-in session for this host? Lets background
		// sync run without ever triggering a passphrase/MFA prompt.
		session: async ({ host }) => ({ active: sessions.has(host) }),

		syncPlan: async ({ remoteDir, manifest, exclude }) => {
			const session = requireSession();
			const dir = sync.resolveRemoteDir(session.home, remoteDir);
			const planned = await sync.syncPlan(session.sftp, dir, manifest, exclude);
			const planId = crypto.randomUUID();
			state.plans.set(planId, {
				kind: 'sync',
				dir,
				planned,
				uploadSet: new Set(planned.upload),
				uploaded: new Map(),
				dirCache: new Map(),
			});
			return {
				planId,
				remoteDir: dir,
				upload: planned.upload,
				download: planned.download,
				deleteRemote: planned.deleteRemote,
				deleteLocal: planned.deleteLocal,
				serverWins: planned.serverWins,
				unchanged: planned.unchanged.length,
				adopted: planned.adopted.size,
			};
		},

		commit: async ({ planId, downloaded, deletedLocal }) => {
			const session = requireSession();
			const p = state.plans.get(planId);
			if (!p) throw new BridgeError('BAD_PLAN', 'Unknown or finished plan');
			const missing = p.planned.upload.filter((rel) => !p.uploaded.has(rel));
			if (missing.length) {
				throw new BridgeError(
					'MISSING_UPLOADS',
					`${missing.length} planned files were not uploaded`,
					{ missing },
				);
			}
			if (p.kind === 'sync') {
				const r = await sync.commitSync(
					session.sftp,
					p.dir,
					p.planned,
					p.uploaded,
					{ downloaded, deletedLocal },
					p.dirCache,
				);
				state.plans.delete(planId);
				return {
					remoteDir: p.dir,
					uploaded: p.planned.upload.length,
					bytes: [...p.uploaded.values()].reduce((n, s) => n + s.size, 0),
					downloaded: r.downloaded,
					deletedRemote: r.deletedRemote,
					deletedLocal: r.deletedLocal,
					serverWins: p.planned.serverWins,
					notApplied: r.notApplied,
					unchanged: p.planned.unchanged.length,
					adopted: p.planned.adopted.size,
				};
			}
			const { deleted } = await sync.commit(
				session.sftp,
				p.dir,
				p.planned,
				p.uploaded,
				p.dirCache,
			);
			state.plans.delete(planId);
			const bytes = [...p.uploaded.values()].reduce((n, s) => n + s.size, 0);
			return {
				remoteDir: p.dir,
				uploaded: p.planned.upload.length,
				bytes,
				deleted: deleted.length,
				unchanged: p.planned.unchanged.length,
				adopted: p.planned.adopted.size,
				remoteEdited: p.planned.remoteEdited,
				conflicts: p.planned.conflicts,
			};
		},
	};

	ws.on('message', async (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString('utf8'));
		} catch {
			return ws.close(4400, 'invalid JSON');
		}

		// Prompt answers are not requests and carry no id.
		if (msg.op === 'auth-response') {
			const pending = state.prompts.get(msg.promptId);
			if (!pending || !state.authed) return;
			clearTimeout(pending.timer);
			state.prompts.delete(msg.promptId);
			pending.resolve(
				Array.isArray(msg.responses) ? msg.responses.map(String) : null,
			);
			return;
		}

		const { id, op } = msg;
		const started = Date.now();
		if (!state.authed && op !== 'hello') {
			send({
				id,
				ok: false,
				error: { code: 'NOT_AUTHENTICATED', message: 'Send hello first' },
			});
			return ws.close(4401, 'not authenticated');
		}
		const handler = Object.hasOwn(ops, op) ? ops[op] : null;
		if (!handler) {
			return send({
				id,
				ok: false,
				error: { code: 'BAD_OP', message: `Unknown op ${op}` },
			});
		}
		try {
			const result = await handler(msg);
			if (op !== 'put' && op !== 'get' && op !== 'ping')
				log(conn, 'ok', `${op} ${Date.now() - started}ms`);
			send({ id, ok: true, result });
		} catch (err) {
			const error = errorPayload(err);
			log(conn, 'err', `${op} ${error.code}: ${error.message}`);
			send({ id, ok: false, error });
		}
	});

	ws.on('close', (code) => {
		clearTimeout(helloTimer);
		for (const { resolve, timer } of state.prompts.values()) {
			clearTimeout(timer);
			resolve(null);
		}
		// The SSH session stays in the pool for the next connection.
		log(conn, 'info', `closed (${code})`);
	});
}

// The token is saved in the user's profile so it survives restarts and only
// has to be pasted into TeXlyre once. `--new-token` rotates it.
function loadToken() {
	if (process.env.BRIDGE_TOKEN)
		return { token: process.env.BRIDGE_TOKEN, source: 'BRIDGE_TOKEN' };
	const file = path.join(CONFIG.stateDir, 'token');
	if (!process.argv.includes('--new-token')) {
		try {
			const saved = fs.readFileSync(file, 'utf8').trim();
			if (saved.length >= 16) return { token: saved, source: file };
		} catch {}
	}
	const token = crypto.randomBytes(18).toString('base64url');
	fs.mkdirSync(CONFIG.stateDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	return { token, source: `${file} (new)` };
}

function main() {
	const { token, source } = loadToken();
	CONFIG.token = token;
	const wss = new WebSocketServer({
		host: CONFIG.host,
		port: CONFIG.port,
		maxPayload: CONFIG.maxPayloadMB * 1024 * 1024,
		verifyClient: ({ origin }, done) => {
			// Browsers always send Origin; local non-browser tools may not.
			if (!origin || CONFIG.allowedOrigins.includes(origin)) return done(true);
			console.log(`${ts()} [--] deny origin ${origin}`);
			done(false, 403, 'Origin not allowed');
		},
	});
	wss.on('connection', handleConnection);
	wss.on('listening', () => {
		console.log(
			`texlyre-sftp-bridge ${VERSION} listening on ws://${CONFIG.host}:${CONFIG.port}`,
		);
		console.log(`ssh config: ${sshConfig.configPath()}`);
		console.log(`allowed origins: ${CONFIG.allowedOrigins.join(', ')}`);
		if (CONFIG.allowNoToken) {
			console.log(
				'WARNING: SFTP_BRIDGE_ALLOW_NO_TOKEN=1, token check disabled (dev only)',
			);
		}
		console.log(
			`token: ${CONFIG.token}   (from ${source}; run with --new-token to rotate)`,
		);
	});
	wss.on('error', (err) => {
		console.error(`bridge failed: ${err.message}`);
		process.exit(1);
	});
}

if (require.main === module) main();

module.exports = { CONFIG, main };
