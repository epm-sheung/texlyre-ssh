// lib/connect.cjs
// Opens an SSH + SFTP session for an ~/.ssh/config alias, including
// ProxyJump chains, ProxyCommand, agent/key/keyboard-interactive auth and
// known_hosts verification.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { Duplex } = require('node:stream');
const { Client, utils } = require('ssh2');

const knownHosts = require('./knownHosts.cjs');
const sshConfig = require('./sshConfig.cjs');

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';
const MAX_PROXY_DEPTH = 8;

class BridgeError extends Error {
	constructor(code, message, details) {
		super(message);
		this.code = code;
		this.details = details;
	}
}

function agentPath() {
	if (process.env.SFTP_BRIDGE_NO_AGENT) return null;
	if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
	if (process.platform === 'win32') {
		try {
			if (fs.existsSync(WINDOWS_AGENT_PIPE)) return WINDOWS_AGENT_PIPE;
		} catch {}
	}
	return null;
}

async function keyAuth(file, cfg, prompt, log) {
	let data;
	try {
		data = fs.readFileSync(file);
	} catch (err) {
		if (cfg.explicitIdentities)
			log('warn', `IdentityFile ${file}: ${err.code}`);
		return null;
	}

	const parsed = utils.parseKey(data);
	if (!(parsed instanceof Error)) {
		return { type: 'publickey', username: cfg.user, key: data };
	}
	if (!/passphrase/i.test(parsed.message)) {
		log('warn', `IdentityFile ${file}: ${parsed.message}`);
		return null;
	}
	if (!prompt) {
		log('warn', `IdentityFile ${file} is encrypted and no prompt is available`);
		return null;
	}

	const answers = await prompt({
		title: `Passphrase for ${file}`,
		prompts: [{ prompt: `Enter passphrase for ${file}: `, echo: false }],
	});
	const passphrase = answers?.[0];
	if (!passphrase) return null;
	if (utils.parseKey(data, passphrase) instanceof Error) {
		log('warn', `IdentityFile ${file}: wrong passphrase`);
		return null;
	}
	return { type: 'publickey', username: cfg.user, key: data, passphrase };
}

function buildAuthQueue(cfg, prompt, log) {
	const queue = [];
	const agent = agentPath();

	if (agent && !cfg.identitiesOnly) {
		queue.push({
			method: 'publickey',
			label: 'agent',
			make: async () => ({ type: 'agent', username: cfg.user, agent }),
		});
	}

	for (const file of cfg.identityFiles) {
		queue.push({
			method: 'publickey',
			label: file,
			make: () => keyAuth(file, cfg, prompt, log),
		});
	}

	if (prompt) {
		// Also covers MFA (e.g. Duo on HPC clusters) after partial
		// publickey success.
		queue.push({
			method: 'keyboard-interactive',
			label: 'keyboard-interactive',
			make: async () => ({
				type: 'keyboard-interactive',
				username: cfg.user,
				prompt: (name, instructions, _lang, prompts, finish) => {
					if (prompts.length === 0) return finish([]);
					prompt({
						title: name || `${cfg.user}@${cfg.hostName}`,
						instructions,
						prompts,
					}).then(
						(answers) => finish(answers || []),
						() => finish([]),
					);
				},
			}),
		});
		queue.push({
			method: 'password',
			label: 'password',
			make: async () => {
				const answers = await prompt({
					title: `Password for ${cfg.user}@${cfg.hostName}`,
					prompts: [{ prompt: 'Password: ', echo: false }],
				});
				return answers?.[0]
					? { type: 'password', username: cfg.user, password: answers[0] }
					: null;
			},
		});
	}

	return queue;
}

function makeAuthHandler(queue, state, log) {
	return (methodsLeft, partialSuccess, callback) => {
		if (partialSuccess)
			log(
				'info',
				`partial auth success; server wants: ${methodsLeft.join(',')}`,
			);
		(async () => {
			while (queue.length) {
				const attempt = queue.shift();
				if (methodsLeft && !methodsLeft.includes(attempt.method)) continue;
				let auth = null;
				try {
					auth = await attempt.make();
				} catch (err) {
					log('warn', `auth ${attempt.label}: ${err.message}`);
				}
				if (auth) {
					state.tried.push(attempt.label);
					return auth;
				}
			}
			return false;
		})().then(callback, () => callback(false));
	};
}

function verifyHost(cfg, blob, hostCheck, log) {
	const host = cfg.hostKeyAlias || cfg.hostName;
	const port = cfg.hostKeyAlias ? 22 : cfg.port;
	const res = knownHosts.check(cfg.userKnownHostsFiles, host, port, blob);
	const strict = cfg.strictHostKeyChecking;
	const lax = strict === 'no' || strict === 'off';
	hostCheck.result = { ...res, host, port };

	let accepted = false;
	if (res.status === 'match') {
		accepted = true;
	} else if (res.status === 'mismatch' && lax) {
		log(
			'warn',
			`HOST KEY CHANGED for ${host} (${res.fingerprint}); accepted because StrictHostKeyChecking=${strict}`,
		);
		accepted = true;
	} else if (res.status === 'unknown' && (lax || strict === 'accept-new')) {
		log(
			'warn',
			`accepting unknown ${res.type} key ${res.fingerprint} for ${host} (StrictHostKeyChecking=${strict}); not saved`,
		);
		accepted = true;
	}
	hostCheck.accepted = accepted;
	return accepted;
}

function translateError(err, cfg, hostCheck, authState) {
	const target = `${cfg.user}@${cfg.hostName}:${cfg.port}`;
	const hk = hostCheck.result;
	if (hk && hostCheck.accepted === false) {
		const where = hk.port === 22 ? hk.host : `[${hk.host}]:${hk.port}`;
		if (hk.status === 'unknown') {
			return new BridgeError(
				'HOST_KEY_UNKNOWN',
				`Host key for ${where} is not in known_hosts (${hk.type} ${hk.fingerprint}). ` +
					`Run "${cfg.sshCommand || `ssh ${cfg.alias}`}" once in a terminal to verify and save it.`,
				hk,
			);
		}
		if (hk.status === 'mismatch') {
			return new BridgeError(
				'HOST_KEY_MISMATCH',
				`HOST KEY MISMATCH for ${where}: server sent ${hk.type} ${hk.fingerprint}, ` +
					'which differs from known_hosts. Refusing to connect.',
				hk,
			);
		}
		return new BridgeError(
			'HOST_KEY_REVOKED',
			`Host key ${hk.fingerprint} for ${where} is revoked`,
			hk,
		);
	}
	if (err.level === 'client-authentication') {
		return new BridgeError(
			'AUTH_FAILED',
			`Authentication failed for ${target} (tried: ${authState.tried.join(', ') || 'nothing'})`,
			{ tried: authState.tried },
		);
	}
	if (err.level === 'client-timeout') {
		return new BridgeError('TIMEOUT', `Timed out connecting to ${target}`);
	}
	return new BridgeError('CONNECT_FAILED', `${target}: ${err.message}`);
}

function connectOne(cfg, { sock, prompt, log }) {
	return new Promise((resolve, reject) => {
		const client = new Client();
		const hostCheck = {};
		const authState = { tried: [] };
		let settled = false;

		client.on('ready', () => {
			settled = true;
			log(
				'info',
				`connected ${cfg.user}@${cfg.hostName}:${cfg.port} via ${authState.tried.join(' + ')}`,
			);
			resolve(client);
		});
		client.on('error', (err) => {
			if (settled) {
				log('warn', `${cfg.alias}: ${err.message}`);
				return;
			}
			settled = true;
			reject(translateError(err, cfg, hostCheck, authState));
		});

		client.connect({
			host: cfg.hostName,
			port: cfg.port,
			username: cfg.user,
			sock,
			// readyTimeout spans auth too, so leave room for a human answering
			// an MFA / passphrase prompt in the browser.
			readyTimeout: prompt ? 180000 : cfg.connectTimeout * 1000,
			keepaliveInterval: 15000,
			keepaliveCountMax: 4,
			hostVerifier: (key) => verifyHost(cfg, key, hostCheck, log),
			authHandler: makeAuthHandler(
				buildAuthQueue(cfg, prompt, log),
				authState,
				log,
			),
		});
	});
}

function forwardOut(client, host, port) {
	return new Promise((resolve, reject) => {
		client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
			if (err) {
				reject(
					new BridgeError(
						'PROXY_JUMP_FAILED',
						`Jump host could not reach ${host}:${port}: ${err.message}`,
					),
				);
			} else {
				resolve(stream);
			}
		});
	});
}

function spawnProxyCommand(command, log) {
	// ProxyCommand runs through the system shell exactly as OpenSSH would.
	// Note: a ProxyCommand that itself needs an interactive prompt (MFA,
	// passphrase) fails here because it has no TTY.
	const child = spawn(command, {
		shell: true,
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stderr = '';
	child.stderr.on('data', (chunk) => {
		stderr = (stderr + chunk).slice(-4096);
	});
	child.on('exit', (code) => {
		if (code) log('warn', `ProxyCommand exited with ${code}: ${stderr.trim()}`);
	});
	const sock = Duplex.from({ readable: child.stdout, writable: child.stdin });
	sock.on('close', () => child.kill());
	return sock;
}

async function connectChain(cfg, ctx, depth = 0) {
	if (depth > MAX_PROXY_DEPTH) {
		throw new BridgeError(
			'PROXY_LOOP',
			`ProxyJump chain deeper than ${MAX_PROXY_DEPTH}`,
		);
	}
	const clients = [];
	try {
		let sock;
		if (cfg.proxyJump) {
			let prev = null;
			for (const spec of cfg.proxyJump
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)) {
				const hopCfg = sshConfig.resolveHostSpec(spec);
				ctx.log(
					'info',
					`ProxyJump hop ${hopCfg.user}@${hopCfg.hostName}:${hopCfg.port}`,
				);
				if (!prev) {
					const hop = await connectChain(hopCfg, ctx, depth + 1);
					clients.push(...hop.clients);
					prev = hop.client;
				} else {
					const hopSock = await forwardOut(prev, hopCfg.hostName, hopCfg.port);
					prev = await connectOne(hopCfg, { ...ctx, sock: hopSock });
					clients.push(prev);
				}
			}
			sock = await forwardOut(prev, cfg.hostName, cfg.port);
		} else if (cfg.proxyCommand) {
			ctx.log('info', `ProxyCommand: ${cfg.proxyCommand}`);
			sock = spawnProxyCommand(cfg.proxyCommand, ctx.log);
		}
		const client = await connectOne(cfg, { ...ctx, sock });
		clients.push(client);
		return { client, clients };
	} catch (err) {
		for (const c of clients.reverse()) c.end();
		throw err;
	}
}

// "alias" from ~/.ssh/config, or "[user@]host[:port]". These reach %h/%r
// in ProxyCommand, which runs in a shell: keep every part boring.
const HOST_SPEC_RE =
	/^(?:([A-Za-z0-9._-]{1,64})@)?([A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::(\d{1,5}))?$/;

function parseTarget(spec) {
	const m = HOST_SPEC_RE.exec(spec || '');
	const port = m?.[3] ? Number(m[3]) : undefined;
	if (!m || (port !== undefined && (port < 1 || port > 65535))) {
		throw new BridgeError(
			'BAD_HOST',
			`Invalid host "${spec}": use an alias from ~/.ssh/config or user@host[:port]`,
		);
	}
	return { user: m[1], host: m[2], port };
}

async function openSession(spec, ctx) {
	const { user, host, port } = parseTarget(spec);
	const cfg = sshConfig.resolve(host, { user, port });
	cfg.sshCommand = port
		? `ssh -p ${port} ${user ? `${user}@` : ''}${host}`
		: `ssh ${spec}`;
	const { client, clients } = await connectChain(cfg, ctx);
	const close = () => {
		for (const c of [...clients].reverse()) c.end();
	};
	try {
		const sftp = await new Promise((resolve, reject) => {
			client.sftp((err, s) =>
				err
					? reject(
							new BridgeError(
								'SFTP_UNAVAILABLE',
								`SFTP subsystem unavailable on ${alias}: ${err.message}`,
							),
						)
					: resolve(s),
			);
		});
		const home = await new Promise((resolve, reject) => {
			sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p)));
		});
		return { cfg, client, sftp, home, close };
	} catch (err) {
		close();
		throw err;
	}
}

module.exports = { BridgeError, openSession };
