// lib/sshConfig.cjs
// Resolves an ~/.ssh/config alias into connection parameters, following the
// subset of OpenSSH semantics the bridge needs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SSHConfig = require('ssh-config');

const DEFAULT_IDENTITIES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function configPath() {
	return process.env.SSH_CONFIG || path.join(os.homedir(), '.ssh', 'config');
}

function sshDir() {
	return path.dirname(configPath());
}

function load() {
	try {
		return SSHConfig.parse(fs.readFileSync(configPath(), 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return SSHConfig.parse('');
		throw err;
	}
}

function expandHome(p) {
	if (!p) return p;
	if (p === '~') return os.homedir();
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

function hostPatterns(value) {
	const values = Array.isArray(value) ? value : [value];
	return values.map((v) => (typeof v === 'string' ? v : v.val)).filter(Boolean);
}

// Concrete aliases only: wildcard and negated patterns are not connectable.
function listHosts() {
	const hosts = [];
	for (const line of load()) {
		if (line.param?.toLowerCase() !== 'host') continue;
		for (const name of hostPatterns(line.value)) {
			if (!/[*?!]/.test(name)) hosts.push(name);
		}
	}
	return [...new Set(hosts)];
}

function first(value) {
	return Array.isArray(value) ? value[0] : value;
}

function expandTokens(str, { alias, hostName, port, user }) {
	return str.replace(/%([%hnpr])/g, (_, token) => {
		switch (token) {
			case '%':
				return '%';
			case 'h':
				return hostName;
			case 'n':
				return alias;
			case 'p':
				return String(port);
			case 'r':
				return user;
		}
	});
}

// "[user@]host[:port]" as used in ProxyJump entries.
function parseHostSpec(spec) {
	const m = /^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec.trim());
	if (!m) throw new Error(`Cannot parse host spec "${spec}"`);
	return {
		user: m[1],
		host: m[2].replace(/^\[|\]$/g, ''),
		port: m[3] ? Number(m[3]) : undefined,
	};
}

function resolve(alias, overrides = {}) {
	const computed = load().compute(alias);
	const get = (key) => first(computed[key]);

	const port = Number(overrides.port || get('Port') || 22);
	const user = overrides.user || get('User') || os.userInfo().username;
	const rawHostName = get('HostName');
	const hostName = rawHostName
		? rawHostName.replace(/%h/g, alias).replace(/%%/g, '%')
		: alias;
	const ctx = { alias, hostName, port, user };

	const explicitIdentities = computed.IdentityFile
		? [].concat(computed.IdentityFile)
		: [];
	const identityFiles = (
		explicitIdentities.length
			? explicitIdentities
			: DEFAULT_IDENTITIES.map((name) => path.join(sshDir(), name))
	).map((p) => expandHome(expandTokens(p, ctx)));

	const knownHostsRaw = get('UserKnownHostsFile');
	const userKnownHostsFiles = knownHostsRaw
		? String(knownHostsRaw)
				.split(/\s+/)
				.filter((p) => p && p !== '/dev/null' && p.toLowerCase() !== 'none')
				.map(expandHome)
		: [path.join(sshDir(), 'known_hosts'), path.join(sshDir(), 'known_hosts2')];

	const proxyJump = get('ProxyJump');
	const proxyCommand = get('ProxyCommand');

	return {
		alias,
		hostName,
		port,
		user,
		identityFiles,
		explicitIdentities: explicitIdentities.length > 0,
		identitiesOnly: /^yes$/i.test(get('IdentitiesOnly') || ''),
		proxyJump:
			proxyJump && !/^none$/i.test(proxyJump) ? String(proxyJump) : undefined,
		proxyCommand:
			proxyCommand && !/^none$/i.test(proxyCommand)
				? expandTokens(String(proxyCommand), ctx)
				: undefined,
		strictHostKeyChecking: String(
			get('StrictHostKeyChecking') || 'ask',
		).toLowerCase(),
		userKnownHostsFiles,
		hostKeyAlias: get('HostKeyAlias'),
		connectTimeout: Number(get('ConnectTimeout') || 20),
	};
}

// Resolve a ProxyJump element: it may be an alias itself, with optional
// user/port overrides.
function resolveHostSpec(spec) {
	const { user, host, port } = parseHostSpec(spec);
	return resolve(host, { user, port });
}

module.exports = {
	configPath,
	expandHome,
	listHosts,
	resolve,
	resolveHostSpec,
	parseHostSpec,
};
