// extras/backup/sftp/syncApply.ts
// Applies a two-way sync plan from the bridge to the TeXlyre project.
// Kept free of app services (they're passed in) so it can be unit tested.
//
// Server wins when both sides changed: the local version is first saved
// under /.texlyre/sftp-conflicts/<time>/, which TeXlyre never syncs.
import type { FileNode } from '@/types/files';

export interface SyncPlan {
	planId: string;
	upload: string[];
	download: string[];
	deleteRemote: string[];
	deleteLocal: string[];
	serverWins: {
		path: string;
		action: 'download' | 'deleteLocal';
		reason: string;
	}[];
}

export interface SyncApplyDeps {
	getRemote(rel: string): Promise<{
		bytes: Uint8Array<ArrayBuffer>;
		sha256: string;
		mtime: number;
	}>;
	putRemote(rel: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
	storeFiles(nodes: FileNode[]): Promise<void>;
	deleteLocalFile(file: FileNode): Promise<void>;
	// Replaces a linked document's text; the updater sees the live content.
	updateDocument(
		documentId: string,
		updater: (current: string) => string,
	): Promise<void>;
	newId(): string;
	mimeType(name: string): string;
	isBinary(name: string): boolean;
	now(): number;
}

export interface SyncApplyResult {
	downloaded: { path: string; sha256: string }[];
	deletedLocal: string[];
	backups: string[];
	skipped: string[];
}

export const CONFLICT_DIR = '/.texlyre/sftp-conflicts';

const decoder = new TextDecoder();

const asText = (content: FileNode['content']): string | undefined => {
	if (typeof content === 'string') return content;
	return content ? decoder.decode(content) : undefined;
};

export async function applySyncPlan(
	plan: SyncPlan,
	localFiles: Map<string, FileNode>,
	collected: Map<string, Uint8Array<ArrayBuffer>>,
	deps: SyncApplyDeps,
): Promise<SyncApplyResult> {
	const result: SyncApplyResult = {
		downloaded: [],
		deletedLocal: [],
		backups: [],
		skipped: [],
	};
	const wins = new Map(plan.serverWins.map((w) => [w.path, w]));
	const stamp = new Date(deps.now()).toISOString().replace(/[:.]/g, '-');
	const knownDirs = new Set(
		[...localFiles.values()]
			.filter((f) => f.type === 'directory')
			.map((f) => f.path),
	);

	const dirNodesFor = (filePath: string): FileNode[] => {
		const nodes: FileNode[] = [];
		const segments = filePath.split('/').filter(Boolean).slice(0, -1);
		for (let i = 1; i <= segments.length; i++) {
			const dir = `/${segments.slice(0, i).join('/')}`;
			if (knownDirs.has(dir)) continue;
			knownDirs.add(dir);
			nodes.push({
				id: deps.newId(),
				name: segments[i - 1],
				path: dir,
				type: 'directory',
				lastModified: deps.now(),
			});
		}
		return nodes;
	};

	const fileNode = (
		path: string,
		content: ArrayBuffer | string,
		lastModified: number,
	): FileNode => {
		const name = path.slice(path.lastIndexOf('/') + 1);
		return {
			id: deps.newId(),
			name,
			path,
			type: 'file',
			content,
			lastModified,
			size: typeof content === 'string' ? content.length : content.byteLength,
			mimeType: deps.mimeType(name),
			isBinary: deps.isBinary(name),
		};
	};

	const saveBackup = async (rel: string, content: ArrayBuffer | string) => {
		const backupPath = `${CONFLICT_DIR}/${stamp}/${rel}`;
		await deps.storeFiles([
			...dirNodesFor(backupPath),
			fileNode(backupPath, content, deps.now()),
		]);
		result.backups.push(backupPath);
	};

	const downloads = [
		...plan.download,
		...plan.serverWins
			.filter((w) => w.action === 'download')
			.map((w) => w.path),
	];

	for (const rel of downloads) {
		const path = `/${rel}`;
		const existing = localFiles.get(path);
		const serverWins = wins.has(rel);
		const remote = await deps.getRemote(rel);
		const text = decoder.decode(remote.bytes);
		let backupContent: ArrayBuffer | string | undefined =
			serverWins && existing?.content !== undefined
				? existing.content
				: undefined;

		if (existing?.documentId) {
			const expected = collected.has(rel)
				? decoder.decode(collected.get(rel))
				: asText(existing.content);
			let applied = false;
			await deps.updateDocument(existing.documentId, (current) => {
				// The user typed since this sync read the file: leave it for
				// the next round rather than overwrite live edits.
				if (!serverWins && expected !== undefined && current !== expected) {
					return current;
				}
				if (serverWins) backupContent = current;
				applied = true;
				return text;
			});
			if (!applied) {
				result.skipped.push(rel);
				continue;
			}
		}

		if (backupContent !== undefined) await saveBackup(rel, backupContent);

		const lastModified = remote.mtime * 1000;
		await deps.storeFiles(
			existing
				? [
						{
							...existing,
							content: remote.bytes.buffer,
							size: remote.bytes.byteLength,
							lastModified,
						},
					]
				: [
						...dirNodesFor(path),
						fileNode(path, remote.bytes.buffer, lastModified),
					],
		);
		result.downloaded.push({ path, sha256: remote.sha256 });
	}

	const localDeletes = [
		...plan.deleteLocal,
		...plan.serverWins
			.filter((w) => w.action === 'deleteLocal')
			.map((w) => w.path),
	];
	for (const rel of localDeletes) {
		const path = `/${rel}`;
		const existing = localFiles.get(path);
		if (existing) {
			if (wins.has(rel) && existing.content !== undefined) {
				await saveBackup(rel, existing.content);
			}
			await deps.deleteLocalFile(existing);
		}
		result.deletedLocal.push(path);
	}

	for (const rel of plan.upload) {
		const bytes = collected.get(rel);
		if (bytes) await deps.putRemote(rel, bytes);
	}

	return result;
}
