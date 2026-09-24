// test/sshServer.cjs
// Minimal SSH server for bridge tests: publickey auth with real signature
// checks, optional Duo-style keyboard-interactive second factor, SFTP backed
// by a local directory, and direct-tcpip forwarding (for ProxyJump).
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Server, utils } = require('ssh2');

const { STATUS_CODE } = utils.sftp;

function attrsFromStat(st) {
	return {
		mode: st.mode,
		uid: 0,
		gid: 0,
		size: st.size,
		atime: Math.floor(st.atimeMs / 1000),
		mtime: Math.floor(st.mtimeMs / 1000),
	};
}

function startServer({
	rootDir,
	home = '/home/tester',
	allowedPublicKey,
	mfa = false,
	name,
}) {
	const hostKey = utils.generateKeyPairSync('ed25519');
	const allowed = utils.parseKey(allowedPublicKey);
	const events = { forwards: [], logins: 0, mfaPrompts: 0 };
	fs.mkdirSync(path.join(rootDir, home), { recursive: true });

	const toLocal = (remote) => {
		const abs = path.posix.resolve(home, remote);
		return path.join(rootDir, ...abs.split('/').filter(Boolean));
	};

	const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
		let pubkeyOk = false;

		client.on('authentication', (ctx) => {
			if (ctx.method === 'publickey') {
				const match =
					ctx.key.algo === allowed.type &&
					ctx.key.data.equals(allowed.getPublicSSH());
				if (!match) return ctx.reject(['publickey']);
				if (!ctx.signature) return ctx.accept(); // key probe
				if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true)
					return ctx.reject();
				if (!mfa) return ctx.accept();
				pubkeyOk = true;
				return ctx.reject(['keyboard-interactive'], true);
			}
			if (ctx.method === 'keyboard-interactive' && mfa && pubkeyOk) {
				events.mfaPrompts++;
				return ctx.prompt(
					[{ prompt: 'Passcode or option (1-1): ', echo: true }],
					'Duo two-factor login',
					'1. Duo Push to XXX-XXX-1234',
					(answers) => (answers[0] === '1' ? ctx.accept() : ctx.reject()),
				);
			}
			ctx.reject(mfa && pubkeyOk ? ['keyboard-interactive'] : ['publickey']);
		});

		client.on('ready', () => {
			events.logins++;
			client.on('tcpip', (accept, reject, info) => {
				events.forwards.push(`${info.destIP}:${info.destPort}`);
				const upstream = net.connect(info.destPort, info.destIP);
				upstream.on('connect', () => {
					const channel = accept();
					channel.pipe(upstream).pipe(channel);
				});
				upstream.on('error', () => reject());
			});
			client.on('session', (acceptSession) => {
				const session = acceptSession();
				session.on('sftp', (acceptSftp) =>
					serveSftp(acceptSftp(), toLocal, home),
				);
			});
		});
		client.on('error', () => {});
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			resolve({
				name,
				port: server.address().port,
				hostPublicBlob: utils.parseKey(hostKey.private).getPublicSSH(),
				events,
				close: () => server.close(),
			});
		});
	});
}

function serveSftp(sftp, toLocal, home) {
	const handles = new Map();
	let nextHandle = 0;
	const fail = (reqid, err) =>
		sftp.status(
			reqid,
			err?.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE,
			err?.message,
		);

	sftp.on('REALPATH', (reqid, p) => {
		const abs = path.posix.resolve(home, p);
		sftp.name(reqid, [{ filename: abs, longname: abs, attrs: {} }]);
	});
	for (const op of ['STAT', 'LSTAT']) {
		sftp.on(op, (reqid, p) => {
			try {
				sftp.attrs(reqid, attrsFromStat(fs.statSync(toLocal(p))));
			} catch (err) {
				fail(reqid, err);
			}
		});
	}
	sftp.on('OPEN', (reqid, filename, flags) => {
		try {
			const fd = fs.openSync(
				toLocal(filename),
				utils.sftp.flagsToString(flags),
			);
			const h = Buffer.alloc(4);
			h.writeUInt32BE(nextHandle++);
			handles.set(h.toString('hex'), fd);
			sftp.handle(reqid, h);
		} catch (err) {
			fail(reqid, err);
		}
	});
	const fdOf = (h) => handles.get(h.toString('hex'));
	sftp.on('FSTAT', (reqid, h) => {
		try {
			sftp.attrs(reqid, attrsFromStat(fs.fstatSync(fdOf(h))));
		} catch (err) {
			fail(reqid, err);
		}
	});
	sftp.on('READ', (reqid, h, offset, length) => {
		try {
			const buf = Buffer.alloc(length);
			const n = fs.readSync(fdOf(h), buf, 0, length, offset);
			if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
			sftp.data(reqid, buf.subarray(0, n));
		} catch (err) {
			fail(reqid, err);
		}
	});
	sftp.on('WRITE', (reqid, h, offset, data) => {
		try {
			fs.writeSync(fdOf(h), data, 0, data.length, offset);
			sftp.status(reqid, STATUS_CODE.OK);
		} catch (err) {
			fail(reqid, err);
		}
	});
	const dirHandles = new Map();
	sftp.on('OPENDIR', (reqid, p) => {
		try {
			const local = toLocal(p);
			const names = fs.readdirSync(local).map((name) => ({
				filename: name,
				longname: name,
				attrs: attrsFromStat(fs.lstatSync(path.join(local, name))),
			}));
			const h = Buffer.alloc(4);
			h.writeUInt32BE(nextHandle++);
			dirHandles.set(h.toString('hex'), { names, sent: false });
			sftp.handle(reqid, h);
		} catch (err) {
			fail(reqid, err);
		}
	});
	sftp.on('READDIR', (reqid, h) => {
		const d = dirHandles.get(h.toString('hex'));
		if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);
		if (d.sent || d.names.length === 0)
			return sftp.status(reqid, STATUS_CODE.EOF);
		d.sent = true;
		sftp.name(reqid, d.names);
	});
	sftp.on('CLOSE', (reqid, h) => {
		if (dirHandles.delete(h.toString('hex')))
			return sftp.status(reqid, STATUS_CODE.OK);
		try {
			fs.closeSync(fdOf(h));
			handles.delete(h.toString('hex'));
			sftp.status(reqid, STATUS_CODE.OK);
		} catch (err) {
			fail(reqid, err);
		}
	});
	sftp.on('MKDIR', (reqid, p) => {
		try {
			fs.mkdirSync(toLocal(p));
			sftp.status(reqid, STATUS_CODE.OK);
		} catch (err) {
			fail(reqid, err);
		}
	});
	sftp.on('REMOVE', (reqid, p) => {
		try {
			fs.unlinkSync(toLocal(p));
			sftp.status(reqid, STATUS_CODE.OK);
		} catch (err) {
			fail(reqid, err);
		}
	});
	for (const op of ['SETSTAT', 'FSETSTAT']) {
		sftp.on(op, (reqid) => sftp.status(reqid, STATUS_CODE.OK));
	}
}

module.exports = { startServer };
