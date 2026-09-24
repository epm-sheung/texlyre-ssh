// lib/sftpSync.cjs
// Push-only mirror of a TeXlyre project into a remote directory.
//
// The remote directory holds a .texlyre-sync.json with {sha256, size, mtime}
// for every file the bridge last wrote. That lets a push:
//   - skip files whose content did not change,
//   - refuse to overwrite files edited on the server since the last push
//     (size/mtime drift) or files it never wrote, unless `force`,
//   - delete only files it created itself, never build outputs or other
//     files that live next to the project on the server.
const crypto = require('node:crypto');
const path = require('node:path');

const { BridgeError } = require('./connect.cjs');

const STATE_FILE = '.texlyre-sync.json';
const SFTP_NO_SUCH_FILE = 2;
const STAT_CONCURRENCY = 32;
const HASH_CONCURRENCY = 8;
const ADOPT_MAX_BYTES = 64 * 1024 * 1024;
const LIST_MAX_FILES = 10000;
const GET_MAX_BYTES = 48 * 1024 * 1024;

function wrapSftp(sftp) {
	const call = (fn, ...args) =>
		new Promise((resolve, reject) => {
			sftp[fn](...args, (err, res) => (err ? reject(err) : resolve(res)));
		});
	return {
		stat: (p) =>
			call('stat', p).catch((err) => {
				if (err.code === SFTP_NO_SUCH_FILE) return null;
				throw err;
			}),
		mkdir: (p) => call('mkdir', p),
		readdir: (p) => call('readdir', p),
		readFile: (p) => call('readFile', p),
		writeFile: (p, data) => call('writeFile', p, data),
		unlink: (p) => call('unlink', p),
	};
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return out;
}

function resolveRemoteDir(home, dir) {
	if (typeof dir !== 'string' || !dir.trim()) {
		throw new BridgeError('BAD_PATH', 'Remote directory is required');
	}
	let d = dir.trim();
	if (d === '~') d = home;
	else if (d.startsWith('~/')) d = `${home}/${d.slice(2)}`;
	else if (!d.startsWith('/')) d = `${home}/${d}`;
	d = path.posix.normalize(d).replace(/\/+$/, '');
	if (!d || d === '/')
		throw new BridgeError('BAD_PATH', 'Refusing to push into /');
	return d;
}

// Project paths arrive as "/main.tex", "/figures/a.png".
function cleanRelPath(p) {
	if (typeof p !== 'string')
		throw new BridgeError('BAD_PATH', 'Path must be a string');
	const rel = p.replace(/^\/+/, '');
	const segments = rel.split('/');
	if (
		!rel ||
		rel.includes('\\') ||
		rel.includes('\0') ||
		segments.some((s) => s === '' || s === '.' || s === '..') ||
		rel === STATE_FILE
	) {
		throw new BridgeError('BAD_PATH', `Unsafe path "${p}"`);
	}
	return rel;
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}

async function readState(fsx, remoteDir) {
	try {
		const raw = await fsx.readFile(`${remoteDir}/${STATE_FILE}`);
		const state = JSON.parse(raw.toString('utf8'));
		if (state && typeof state.files === 'object') return state;
	} catch (err) {
		if (err.code !== SFTP_NO_SUCH_FILE && !(err instanceof SyntaxError))
			throw err;
	}
	return { version: 1, files: {} };
}

const sameStat = (st, entry) =>
	!!st && !!entry && st.size === entry.size && st.mtime === entry.mtime;

async function plan(sftp, remoteDir, manifest, { force = false } = {}) {
	const fsx = wrapSftp(sftp);
	if (!Array.isArray(manifest))
		throw new BridgeError('BAD_REQUEST', 'manifest must be an array');

	const local = new Map();
	for (const entry of manifest) {
		const rel = cleanRelPath(entry.path);
		if (!/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
			throw new BridgeError('BAD_REQUEST', `Bad sha256 for ${entry.path}`);
		}
		local.set(rel, entry.sha256);
	}

	const state = await readState(fsx, remoteDir);
	const tracked = Object.keys(state.files);
	const allPaths = [...new Set([...local.keys(), ...tracked])];
	const statList = await mapLimit(allPaths, STAT_CONCURRENCY, (rel) =>
		fsx.stat(`${remoteDir}/${rel}`),
	);
	const stats = new Map(allPaths.map((rel, i) => [rel, statList[i]]));

	const result = {
		upload: [],
		delete: [],
		unchanged: [],
		remoteEdited: [], // local unchanged, server copy edited: left alone
		conflicts: [],
		untrack: [], // tracked but already gone on the server
		adopted: new Map(), // rel -> fresh stat; content already matches, just (re)track it
	};

	// size/mtime can't tell whether a drifted or never-tracked server file
	// differs, so hash the server copy in those cases. This makes a first
	// push into an existing folder (e.g. right after importing it) adopt
	// identical files instead of reporting every one as a conflict, and
	// ignores touch/checkout-only mtime changes.
	const hashCache = new Map();
	const remoteHash = (rel, st) => {
		if (st.size > ADOPT_MAX_BYTES) return Promise.resolve(null);
		if (!hashCache.has(rel)) {
			hashCache.set(
				rel,
				fsx.readFile(`${remoteDir}/${rel}`).then(sha256, () => null),
			);
		}
		return hashCache.get(rel);
	};

	const decideLocal = async ([rel, hash]) => {
		const prev = state.files[rel];
		const st = stats.get(rel);
		if (st?.isDirectory()) {
			result.conflicts.push({ path: rel, reason: 'remote-is-directory' });
			return;
		}
		if (!st) {
			result.upload.push(rel);
			return;
		}
		if (prev && sameStat(st, prev)) {
			(prev.sha256 === hash ? result.unchanged : result.upload).push(rel);
			return;
		}
		const rh = await remoteHash(rel, st);
		if (rh === hash) {
			result.adopted.set(rel, { size: st.size, mtime: st.mtime });
			result.unchanged.push(rel);
		} else if (prev && prev.sha256 === hash) {
			result.remoteEdited.push(rel);
		} else if (force || (prev && rh === prev.sha256)) {
			result.upload.push(rel);
		} else {
			result.conflicts.push({
				path: rel,
				reason: prev ? 'remote-modified' : 'untracked-remote-file',
			});
		}
	};

	const decideTracked = async (rel) => {
		const prev = state.files[rel];
		const st = stats.get(rel);
		if (!st) result.untrack.push(rel);
		else if (sameStat(st, prev) || force) result.delete.push(rel);
		else if ((await remoteHash(rel, st)) === prev.sha256)
			result.delete.push(rel);
		else
			result.conflicts.push({
				path: rel,
				reason: 'remote-modified-local-deleted',
			});
	};

	await mapLimit([...local], HASH_CONCURRENCY, decideLocal);
	await mapLimit(
		tracked.filter((rel) => !local.has(rel)),
		HASH_CONCURRENCY,
		decideTracked,
	);
	for (const key of [
		'upload',
		'delete',
		'unchanged',
		'remoteEdited',
		'untrack',
	]) {
		result[key].sort();
	}
	result.conflicts.sort((a, b) => a.path.localeCompare(b.path));

	return { ...result, state, local };
}

function mkdirp(fsx, dir, cache) {
	if (!cache.has(dir)) {
		cache.set(
			dir,
			(async () => {
				const st = await fsx.stat(dir);
				if (st) {
					if (!st.isDirectory())
						throw new BridgeError(
							'NOT_A_DIRECTORY',
							`${dir} exists and is not a directory`,
						);
					return;
				}
				const parent = path.posix.dirname(dir);
				if (parent !== dir) await mkdirp(fsx, parent, cache);
				try {
					await fsx.mkdir(dir);
				} catch (err) {
					const again = await fsx.stat(dir);
					if (!again?.isDirectory()) throw err;
				}
			})(),
		);
	}
	return cache.get(dir);
}

async function putFile(sftp, remoteDir, rel, content, dirCache) {
	const fsx = wrapSftp(sftp);
	const target = `${remoteDir}/${rel}`;
	await mkdirp(fsx, path.posix.dirname(target), dirCache);
	await fsx.writeFile(target, content);
	const st = await fsx.stat(target);
	return { size: st.size, mtime: st.mtime };
}

async function commit(sftp, remoteDir, planned, uploaded, dirCache) {
	const fsx = wrapSftp(sftp);
	const deleted = [];
	for (const rel of planned.delete) {
		try {
			await fsx.unlink(`${remoteDir}/${rel}`);
		} catch (err) {
			if (err.code !== SFTP_NO_SUCH_FILE) throw err;
		}
		deleted.push(rel);
	}

	const files = {};
	for (const [rel, hash] of planned.local) {
		const up = uploaded.get(rel) || planned.adopted.get(rel);
		if (up) files[rel] = { sha256: hash, size: up.size, mtime: up.mtime };
		else if (planned.state.files[rel]) files[rel] = planned.state.files[rel];
		// untracked conflicts stay untracked
	}

	await mkdirp(fsx, remoteDir, dirCache);
	await fsx.writeFile(
		`${remoteDir}/${STATE_FILE}`,
		JSON.stringify(
			{
				version: 1,
				tool: 'texlyre-sftp-bridge',
				updatedAt: new Date().toISOString(),
				files,
			},
			null,
			1,
		),
	);
	return { deleted };
}

// Exclude patterns: without "/" they match the basename (so "build" prunes
// every directory named build, "*.aux" every aux file); with "/" they match
// the path relative to the remote directory. "*" does not cross "/".
function compileExcludes(patterns) {
	return (patterns || [])
		.map((p) => String(p).trim())
		.filter(Boolean)
		.map((p) => {
			const body = p
				.split('**')
				.map((part) =>
					part
						.replace(/[.+^${}()|[\]\\]/g, '\\$&')
						.replace(/\*/g, '[^/]*')
						.replace(/\?/g, '[^/]'),
				)
				.join('.*');
			return { re: new RegExp(`^${body}$`), onPath: p.includes('/') };
		});
}

async function listTree(sftp, remoteDir, exclude) {
	const fsx = wrapSftp(sftp);
	const root = await fsx.stat(remoteDir);
	if (!root) throw new BridgeError('NOT_FOUND', `${remoteDir} does not exist`);
	if (!root.isDirectory())
		throw new BridgeError('NOT_A_DIRECTORY', `${remoteDir} is not a directory`);

	const matchers = compileExcludes(exclude);
	const isExcluded = (rel) => {
		const base = rel.slice(rel.lastIndexOf('/') + 1);
		return matchers.some(({ re, onPath }) => re.test(onPath ? rel : base));
	};

	const files = [];
	const skipped = {
		excluded: [],
		symlinkedDirs: [],
		unsafeNames: [],
		other: [],
	};
	let totalBytes = 0;

	const walk = async (relDir) => {
		const entries = await fsx.readdir(
			relDir ? `${remoteDir}/${relDir}` : remoteDir,
		);
		entries.sort((a, b) => a.filename.localeCompare(b.filename));
		for (const entry of entries) {
			if (entry.filename === '.' || entry.filename === '..') continue;
			const rel = relDir ? `${relDir}/${entry.filename}` : entry.filename;
			if (rel === STATE_FILE) continue;
			try {
				cleanRelPath(rel);
			} catch {
				skipped.unsafeNames.push(rel);
				continue;
			}
			if (isExcluded(rel)) {
				skipped.excluded.push(rel);
				continue;
			}
			let attrs = entry.attrs;
			if (attrs.isSymbolicLink()) {
				// Follow file symlinks; skip directory symlinks (loops, huge trees).
				const target = await fsx.stat(`${remoteDir}/${rel}`);
				if (!target) continue;
				if (target.isDirectory()) {
					skipped.symlinkedDirs.push(rel);
					continue;
				}
				attrs = target;
			}
			if (attrs.isDirectory()) {
				await walk(rel);
			} else if (attrs.isFile()) {
				files.push({ path: rel, size: attrs.size, mtime: attrs.mtime });
				totalBytes += attrs.size;
				if (files.length > LIST_MAX_FILES) {
					throw new BridgeError(
						'TOO_MANY_FILES',
						`More than ${LIST_MAX_FILES} files under ${remoteDir}; add exclude patterns`,
					);
				}
			} else {
				skipped.other.push(rel);
			}
		}
	};
	await walk('');
	return { files, totalBytes, skipped };
}

// Folder browser: immediate subdirectories of `dir` ("" or "~" = home,
// "/" allowed). Directory symlinks are followed here (unlike listTree),
// because clusters commonly link ~/scratch or ~/projects elsewhere.
async function listDirs(sftp, home, dir) {
	const fsx = wrapSftp(sftp);
	let d = typeof dir === 'string' && dir.trim() ? dir.trim() : '~';
	if (d === '~') d = home;
	else if (d.startsWith('~/')) d = `${home}/${d.slice(2)}`;
	else if (!d.startsWith('/')) d = `${home}/${d}`;
	d = path.posix.normalize(d);
	if (d.length > 1) d = d.replace(/\/+$/, '');

	const st = await fsx.stat(d);
	if (!st) throw new BridgeError('NOT_FOUND', `${d} does not exist`);
	if (!st.isDirectory())
		throw new BridgeError('NOT_A_DIRECTORY', `${d} is not a directory`);

	const entries = await fsx.readdir(d);
	const dirs = [];
	let files = 0;
	await mapLimit(entries, STAT_CONCURRENCY, async (entry) => {
		const name = entry.filename;
		if (name === '.' || name === '..') return;
		let attrs = entry.attrs;
		if (attrs.isSymbolicLink()) {
			attrs = await fsx.stat(`${d === '/' ? '' : d}/${name}`).catch(() => null);
			if (!attrs) return;
			if (attrs.isDirectory()) dirs.push({ name, link: true });
			else files++;
			return;
		}
		if (attrs.isDirectory()) dirs.push({ name, link: false });
		else files++;
	});
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	return {
		path: d,
		parent: d === '/' ? null : path.posix.dirname(d),
		home,
		dirs,
		files,
	};
}

async function getFile(sftp, remoteDir, relPath) {
	const fsx = wrapSftp(sftp);
	const rel = cleanRelPath(relPath);
	const target = `${remoteDir}/${rel}`;
	const st = await fsx.stat(target);
	if (!st) throw new BridgeError('NOT_FOUND', `${rel} does not exist`);
	if (!st.isFile())
		throw new BridgeError('NOT_A_FILE', `${rel} is not a regular file`);
	if (st.size > GET_MAX_BYTES) {
		throw new BridgeError(
			'TOO_LARGE',
			`${rel} is ${st.size} bytes; limit is ${GET_MAX_BYTES}`,
		);
	}
	const buf = await fsx.readFile(target);
	return {
		path: rel,
		content: buf.toString('base64'),
		size: buf.length,
		mtime: st.mtime,
		sha256: sha256(buf),
	};
}

module.exports = {
	STATE_FILE,
	cleanRelPath,
	commit,
	getFile,
	listDirs,
	listTree,
	plan,
	putFile,
	resolveRemoteDir,
	sha256,
};
