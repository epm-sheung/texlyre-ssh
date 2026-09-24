// lib/knownHosts.cjs
// Host key verification against OpenSSH known_hosts files (plain and hashed
// entries, [host]:port form, @revoked markers). @cert-authority lines are
// ignored, so certificate-only hosts show up as unknown.
const crypto = require('node:crypto');
const fs = require('node:fs');

function keyType(blob) {
	const len = blob.readUInt32BE(0);
	return blob.subarray(4, 4 + len).toString('ascii');
}

function fingerprint(blob) {
	return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

function globToRegex(glob) {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	return new RegExp(
		`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
		'i',
	);
}

function patternMatches(pattern, candidate) {
	if (pattern.startsWith('|1|')) {
		const [, , salt, hash] = pattern.split('|');
		if (!salt || !hash) return false;
		const digest = crypto
			.createHmac('sha1', Buffer.from(salt, 'base64'))
			.update(candidate)
			.digest('base64');
		return digest === hash;
	}
	return globToRegex(pattern).test(candidate);
}

function hostListMatches(hostList, candidate) {
	let matched = false;
	for (const raw of hostList.split(',')) {
		const negated = raw.startsWith('!');
		const pattern = negated ? raw.slice(1) : raw;
		if (patternMatches(pattern, candidate)) {
			if (negated) return false;
			matched = true;
		}
	}
	return matched;
}

function* entries(files) {
	for (const file of files) {
		let text;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const parts = trimmed.split(/\s+/);
			let marker = null;
			if (parts[0].startsWith('@')) marker = parts.shift();
			if (parts.length < 3) continue;
			const [hosts, type, b64] = parts;
			yield { file, marker, hosts, type, key: Buffer.from(b64, 'base64') };
		}
	}
}

// Returns { status: 'match' | 'mismatch' | 'unknown' | 'revoked', fingerprint, type }
function check(files, host, port, blob) {
	const candidate = port === 22 ? host : `[${host}]:${port}`;
	const type = keyType(blob);
	let matched = false;
	let revoked = false;
	let sameTypeDifferentKey = false;

	// Scan everything first: a @revoked line must win over a plain match.
	for (const entry of entries(files)) {
		if (entry.marker === '@cert-authority') continue;
		if (!hostListMatches(entry.hosts, candidate)) continue;
		const sameKey = entry.key.equals(blob);
		if (entry.marker === '@revoked') {
			if (sameKey) revoked = true;
			continue;
		}
		if (sameKey) matched = true;
		else if (entry.type === type) sameTypeDifferentKey = true;
	}

	let status = 'unknown';
	if (revoked) status = 'revoked';
	else if (matched) status = 'match';
	else if (sameTypeDifferentKey) status = 'mismatch';
	return { status, fingerprint: fingerprint(blob), type };
}

module.exports = { check, fingerprint, keyType };
