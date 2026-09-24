// test/try-host.cjs
// Live check against a real SSH host from your ~/.ssh/config:
//   node test/try-host.cjs <alias> [remoteDir]
// Starts bridge.cjs, connects once (answer passphrase/MFA prompts here in
// the terminal), then runs four pushes into remoteDir (default
// texlyre-sftp-test, relative to the remote home) and checks each result.
// Must run in an interactive terminal.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const readline = require('node:readline');
const WebSocket = require('ws');

const [alias, remoteDir = 'texlyre-sftp-test'] = process.argv.slice(2);
if (!alias) {
	console.error('usage: node test/try-host.cjs <alias> [remoteDir]');
	process.exit(2);
}
// TRY_HOST_NO_TTY=1: for hosts that never prompt (self-test of this script).
if (!process.stdin.isTTY && process.env.TRY_HOST_NO_TTY !== '1') {
	console.error(
		'Run this in an interactive terminal: it may need to ask for a passphrase or MFA answer.',
	);
	process.exit(2);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function ask(question, hidden) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: true,
		});
		if (hidden) {
			let promptShown = false;
			rl._writeToOutput = (s) => {
				if (!promptShown) {
					promptShown = true;
					process.stdout.write(s);
				}
			};
		}
		rl.question(question, (answer) => {
			rl.close();
			if (hidden) process.stdout.write('\n');
			resolve(answer);
		});
	});
}

async function main() {
	const token = crypto.randomBytes(18).toString('base64url');
	const port = 17000 + Math.floor(Math.random() * 2000);
	const bridge = spawn(
		process.execPath,
		[path.join(__dirname, '..', 'bridge.cjs')],
		{
			env: { ...process.env, WS_PORT: String(port), BRIDGE_TOKEN: token },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	const bridgeLines = [];
	const onBridge = (d) => {
		for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
			if (line.startsWith('token:')) continue;
			bridgeLines.push(line);
			console.log(`  [bridge] ${line}`);
		}
	};
	bridge.stdout.on('data', onBridge);
	bridge.stderr.on('data', onBridge);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('bridge did not start')),
			10000,
		);
		bridge.stdout.on('data', (d) => {
			if (String(d).includes('listening')) {
				clearTimeout(timer);
				resolve();
			}
		});
	});

	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise((resolve, reject) => {
		ws.on('open', resolve);
		ws.on('error', reject);
	});
	const pending = new Map();
	let nextId = 1;
	ws.on('message', async (raw) => {
		const msg = JSON.parse(raw.toString());
		if (msg.event === 'log') return;
		if (msg.event === 'auth-prompt') {
			console.log(`\n=== ${msg.title} ===`);
			if (msg.instructions) console.log(msg.instructions);
			const responses = [];
			for (const p of msg.prompts) responses.push(await ask(p.prompt, !p.echo));
			ws.send(
				JSON.stringify({
					op: 'auth-response',
					promptId: msg.promptId,
					responses,
				}),
			);
			return;
		}
		const p = pending.get(msg.id);
		if (!p) return;
		pending.delete(msg.id);
		msg.ok
			? p.resolve(msg.result)
			: p.reject(Object.assign(new Error(msg.error.message), msg.error));
	});
	const request = (op, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, op, ...params }));
		});

	const project = new Map([
		[
			'README.txt',
			Buffer.from(
				`Test folder written by texlyre-sftp-bridge try-host.cjs on ${new Date().toISOString()}.\nSafe to delete.\n`,
			),
		],
		[
			'main.tex',
			Buffer.from(
				'\\documentclass{article}\n\\begin{document}\nHello from TeXlyre over SFTP.\n\\input{sections/intro}\n\\end{document}\n',
			),
		],
		['sections/intro.tex', Buffer.from('Intro — ünïcödé ✓\n')],
		['refs.bib', Buffer.from('@article{a, title={A}, year={2026}}\n')],
		['figures/blob.bin', crypto.randomBytes(256 * 1024)],
	]);

	const push = async () => {
		const t0 = performance.now();
		const manifest = [...project].map(([rel, buf]) => ({
			path: `/${rel}`,
			sha256: sha256(buf),
		}));
		const plan = await request('plan', { remoteDir, manifest });
		for (const rel of plan.upload) {
			await request('put', {
				planId: plan.planId,
				path: `/${rel}`,
				content: project.get(rel).toString('base64'),
			});
		}
		const result = await request('commit', { planId: plan.planId });
		return { plan, result, ms: Math.round(performance.now() - t0) };
	};

	const results = [];
	const step = async (name, fn) => {
		try {
			const note = await fn();
			results.push(`PASS  ${name}${note ? `  (${note})` : ''}`);
		} catch (err) {
			results.push(
				`FAIL  ${name}: ${err.code ? `${err.code} ` : ''}${err.message}`,
			);
			throw err;
		}
	};

	let remote;
	try {
		await step('hello', async () => {
			const r = await request('hello', { token });
			return `bridge ${r.version}`;
		});
		await step(`connect ${alias}`, async () => {
			const t0 = performance.now();
			const r = await request('connect', { host: alias });
			return `${r.user}@${r.hostName}:${r.port}, home ${r.home}, ${((performance.now() - t0) / 1000).toFixed(1)} s incl. prompts`;
		});
		await step('push 1: new tree', async () => {
			const { plan, result, ms } = await push();
			remote = result.remoteDir;
			assert.equal(result.uploaded, 5);
			assert.deepEqual(plan.conflicts, []);
			return `uploaded ${result.uploaded} files / ${result.bytes} B to ${remote} in ${ms} ms`;
		});
		await step('push 2: nothing changed', async () => {
			const { plan, result, ms } = await push();
			assert.equal(plan.upload.length, 0);
			assert.equal(result.unchanged, 5);
			return `0 uploads, ${result.unchanged} unchanged, ${ms} ms`;
		});
		await step('push 3: one local edit', async () => {
			project.set(
				'main.tex',
				Buffer.from(`${project.get('main.tex')}% edited\n`),
			);
			const { plan, ms } = await push();
			assert.deepEqual(plan.upload, ['main.tex']);
			return `uploaded [${plan.upload}], ${ms} ms`;
		});
		await step('push 4: local delete', async () => {
			project.delete('refs.bib');
			const { plan, result, ms } = await push();
			assert.deepEqual(plan.delete, ['refs.bib']);
			assert.equal(result.deleted, 1);
			return `deleted [${plan.delete}], ${ms} ms`;
		});
	} catch {
		// reported below
	} finally {
		ws.close();
		bridge.kill();
	}

	console.log(`\n${results.join('\n')}`);
	const failed =
		results.some((r) => r.startsWith('FAIL')) || results.length < 6;
	console.log(failed ? '\nRESULT: FAILED' : '\nRESULT: ALL PASSED');
	if (remote) {
		console.log(
			`\nVerify:   ssh ${alias} "ls -la ${remote} ${remote}/sections ${remote}/figures && cat ${remote}/main.tex"`,
		);
		console.log(`Clean up: ssh ${alias} "rm -rf ${remote}"`);
	}
	process.exit(failed ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
