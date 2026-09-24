// test/devServer.cjs
// Manual/browser testing: starts the ssh2 test server as alias "devbox" with
// a throwaway key + known_hosts, then runs bridge.cjs against that config.
//   node test/devServer.cjs <workDir>
// Files pushed to devbox land in <workDir>/server-root/home/tester/...
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { utils } = require('ssh2');

const { startServer } = require('./sshServer.cjs');

async function main() {
	const workDir = path.resolve(
		process.argv[2] || path.join(__dirname, '..', '.dev'),
	);
	fs.mkdirSync(workDir, { recursive: true });
	const serverRoot = path.join(workDir, 'server-root');

	const key = utils.generateKeyPairSync('ed25519');
	fs.writeFileSync(path.join(workDir, 'id_devbox'), key.private);
	const server = await startServer({
		name: 'devbox',
		rootDir: serverRoot,
		allowedPublicKey: key.public,
	});

	const fwd = (p) => p.replace(/\\/g, '/');
	fs.writeFileSync(
		path.join(workDir, 'known_hosts'),
		`[127.0.0.1]:${server.port} ssh-ed25519 ${server.hostPublicBlob.toString('base64')}\n`,
	);
	fs.writeFileSync(
		path.join(workDir, 'ssh_config'),
		[
			'Host devbox',
			'  HostName 127.0.0.1',
			`  Port ${server.port}`,
			'  User tester',
			`  IdentityFile "${fwd(path.join(workDir, 'id_devbox'))}"`,
			`  UserKnownHostsFile "${fwd(path.join(workDir, 'known_hosts'))}"`,
			'',
		].join('\n'),
	);
	console.log(`devbox sshd on 127.0.0.1:${server.port}, root ${serverRoot}`);

	const bridge = spawn(
		process.execPath,
		[path.join(__dirname, '..', 'bridge.cjs')],
		{
			env: {
				...process.env,
				SSH_CONFIG: path.join(workDir, 'ssh_config'),
				SFTP_BRIDGE_HOME: path.join(workDir, 'bridge-state'),
				SFTP_BRIDGE_NO_AGENT: '1',
			},
			stdio: 'inherit',
		},
	);
	bridge.on('exit', (code) => {
		server.close();
		process.exit(code ?? 0);
	});
	process.on('SIGINT', () => bridge.kill());
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
