// extras/backup/sftp/SftpBackupService.ts
// SFTP backup through the local texlyre-sftp-bridge. Mirrors the plain
// project tree (main.tex, figures/, ...) to a server folder so it can be
// compiled or versioned there, rather than TeXlyre's backup layout. Import
// copies an existing server folder into the project once; after that,
// pushes only upload changes.
import { nanoid } from 'nanoid';
import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import type { RecordsContextType } from '@/contexts/RecordsContext';
import { authService } from '@/services/AuthService';
import { documentFileSyncService } from '@/services/DocumentFileSyncService';
import {
	fileStorageEventEmitter,
	fileStoreService,
} from '@/services/FileStoreService';
import { ProjectDataService } from '@/services/ProjectDataService';
import type { BackupActivity, BackupStatus } from '@/types/backup';
import type { FileNode } from '@/types/files';
import { getMimeType, isBinaryFile, isTemporaryFile } from '@/utils/fileUtils';
import { SFTP_DEFAULT_BRIDGE_URL } from './settings';
import {
	type BridgePrompt,
	BridgeRequestError,
	SftpBridgeClient,
	base64ToBytes,
	bytesToBase64,
	sha256Hex,
} from './SftpBridgeClient';

const moduleLog = createNamedLogger('SftpBackupService');

const PLUGIN_ID = 'texlyre-sftp-backup';
const TARGETS_STORAGE_KEY = 'texlyre-sftp-backup-targets';
const RECENT_STORAGE_KEY = 'texlyre-sftp-backup-recent';
const RECENT_LIMIT = 6;
const UPLOAD_CONCURRENCY = 4;

export interface SftpBackupSettings {
	bridgeUrl?: string;
	bridgeToken?: string;
	ignorePatterns?: string[];
	importExclude?: string[];
	maxFileSize?: number;
	activityHistoryLimit?: number;
}

export interface SftpRemoteListing {
	remoteDir: string;
	files: { path: string; size: number; mtime: number }[];
	totalBytes: number;
	skipped: {
		excluded: string[];
		symlinkedDirs: string[];
		unsafeNames: string[];
		other: string[];
	};
}

export interface SftpDirListing {
	path: string;
	parent: string | null;
	home: string;
	dirs: { name: string; link: boolean }[];
	files: number;
}

export interface SftpImportSummary {
	remoteDir: string;
	imported: number;
	bytes: number;
	skipped: string[];
	ms: number;
	push: SftpPushSummary | null;
}

export interface SftpTarget {
	host: string;
	remoteDir: string;
}

export interface SftpBackupStatus extends BackupStatus {
	host?: string;
	remoteDir?: string;
	remoteHome?: string;
	bridgeConnected?: boolean;
}

export interface SftpPushSummary {
	remoteDir: string;
	uploaded: number;
	bytes: number;
	deleted: number;
	unchanged: number;
	adopted: number;
	remoteEdited: string[];
	conflicts: { path: string; reason: string }[];
	skipped: string[];
	ms: number;
}

type ActivityInput = Omit<BackupActivity, 'id' | 'timestamp'>;

const CONFLICT_REASONS: Record<string, string> = {
	'remote-modified': 'edited on the server since the last push',
	'untracked-remote-file':
		'already exists on the server and was not pushed by TeXlyre',
	'remote-modified-local-deleted': 'deleted locally but edited on the server',
	'remote-is-directory': 'is a directory on the server',
};

async function runPool<T>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		}),
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

class SftpBackupService {
	private status: SftpBackupStatus = {
		isConnected: false,
		isEnabled: false,
		lastSync: null,
		status: 'idle',
	};
	private listeners: Array<(status: SftpBackupStatus) => void> = [];
	private activities: BackupActivity[] = [];
	private activityListeners: Array<(activities: BackupActivity[]) => void> = [];
	private summaryListeners: Array<(summary: SftpPushSummary | null) => void> =
		[];
	private lastSummary: SftpPushSummary | null = null;

	private settings: SftpBackupSettings = {};
	private recordsContext: RecordsContextType | null = null;
	private currentProjectId: string | undefined;
	private promptHandler:
		| ((prompt: BridgePrompt) => Promise<string[] | null>)
		| null = null;

	private client = new SftpBridgeClient();
	private dataService = new ProjectDataService();

	constructor() {
		this.client.onPrompt = async (prompt) =>
			this.promptHandler ? this.promptHandler(prompt) : null;
		this.client.onLog = (level, message) => {
			if (level === 'warn') moduleLog.warn(`[bridge] ${message}`);
			else moduleLog.info(`[bridge] ${message}`);
		};
		this.client.onClose = () => {
			this.updateStatus({ bridgeConnected: false });
		};
	}

	setSettings(settings: SftpBackupSettings): void {
		this.settings = { ...settings };
	}

	setRecordsContext(recordsContext: RecordsContextType): void {
		this.recordsContext = recordsContext;
		this.hydrateActivities();
	}

	setCurrentProjectId(projectId: string | undefined): void {
		if (this.currentProjectId === projectId) return;
		this.currentProjectId = projectId;
		this.hydrateActivities();
		this.hydrateTargetStatus();
	}

	setPromptHandler(
		handler: ((prompt: BridgePrompt) => Promise<string[] | null>) | null,
	): void {
		this.promptHandler = handler;
	}

	// BackupServiceInterface: opens the bridge and checks the token.
	async requestAccess(): Promise<{ success: boolean; error?: string }> {
		try {
			await this.ensureBridge();
			return { success: true };
		} catch (error) {
			return { success: false, error: this.errorMessage(error) };
		}
	}

	async listHosts(): Promise<string[]> {
		await this.ensureBridge();
		const { hosts } = await this.client.request<{ hosts: string[] }>('hosts');
		return hosts;
	}

	// Step 1 of the connection flow: open the SSH session (may prompt for a
	// passphrase or MFA in the modal).
	async connectServer(
		host: string,
	): Promise<{ home: string; user: string; hostName: string }> {
		this.updateStatus({ status: 'syncing', error: undefined });
		try {
			const info = await this.connectHost(host);
			this.updateStatus({ status: 'idle' });
			return info;
		} catch (error) {
			this.updateStatus({ status: 'idle' });
			throw error;
		}
	}

	// Step 2: folder browser over the open session.
	async browse(remoteDir: string): Promise<SftpDirListing> {
		return this.client.request<SftpDirListing>('dirs', { remoteDir });
	}

	getRecentTargets(): SftpTarget[] {
		try {
			const list = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
			return Array.isArray(list) ? list.slice(0, RECENT_LIMIT) : [];
		} catch {
			return [];
		}
	}

	private rememberRecent(target: SftpTarget): void {
		try {
			const list = [
				target,
				...this.getRecentTargets().filter(
					(r) => r.host !== target.host || r.remoteDir !== target.remoteDir,
				),
			].slice(0, RECENT_LIMIT);
			localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
		} catch (error) {
			moduleLog.warn('Could not persist recent SFTP targets:', error);
		}
	}

	async connect(target: SftpTarget, projectId?: string): Promise<boolean> {
		try {
			this.updateStatus({ status: 'syncing', error: undefined });
			const info = await this.connectHost(target.host);
			this.saveTarget(projectId, target);
			this.rememberRecent(target);
			this.updateStatus({
				isConnected: true,
				isEnabled: true,
				status: 'idle',
				host: target.host,
				remoteDir: target.remoteDir,
				remoteHome: info.home,
			});
			this.addActivity({
				type: 'backup_complete',
				message: t('Connected to {user}@{host} ({home})', {
					user: info.user,
					host: target.host,
					home: info.home,
				}),
			});
			return true;
		} catch (error) {
			this.handleError(error, 'backup_error', t('SFTP connection failed'));
			return false;
		}
	}

	async disconnect(projectId?: string): Promise<void> {
		if (this.client.isOpen) {
			try {
				await this.client.request('disconnect');
			} catch (error) {
				moduleLog.warn('Bridge disconnect failed:', error);
			}
		}
		this.saveTarget(projectId ?? this.currentProjectId, null);
		this.updateStatus({
			isConnected: false,
			isEnabled: false,
			host: undefined,
			remoteDir: undefined,
			remoteHome: undefined,
		});
	}

	getStoredTarget(projectId?: string): SftpTarget | null {
		return this.loadTargets()[projectId || 'global'] || null;
	}

	async synchronize(projectId?: string, force = false): Promise<void> {
		await this.push(projectId ?? this.currentProjectId, force);
	}

	async exportData(projectId?: string): Promise<void> {
		await this.synchronize(projectId);
	}

	async importChanges(projectId?: string): Promise<void> {
		const id = projectId ?? this.currentProjectId;
		const listing = await this.previewImport(id);
		await this.importFromRemote(id, listing);
	}

	// Lists what an import would bring in, so the UI can confirm first.
	async previewImport(projectId?: string): Promise<SftpRemoteListing> {
		const target = this.getStoredTarget(projectId);
		if (!projectId || !target) {
			throw new Error(t('Open a project and choose an SFTP target first'));
		}
		await this.connectHost(target.host);
		try {
			return await this.client.request<SftpRemoteListing>('list', {
				remoteDir: target.remoteDir,
				exclude: this.settings.importExclude || [],
			});
		} catch (error) {
			if (error instanceof BridgeRequestError && error.code === 'NOT_FOUND') {
				throw new Error(
					t(
						'Folder {dir} was not found on {host}. Click "Change server" to pick another folder.',
						{ dir: target.remoteDir, host: target.host },
					),
				);
			}
			throw error;
		}
	}

	// Copies the remote folder into the project (TeXlyre asks before
	// replacing same-named files), then pushes once so the server copies
	// are adopted as the sync baseline. That push uploads nothing unless the
	// project holds files that are not on the server.
	// TODO: re-import of a folder that was edited on both sides needs a
	// merge path into the Yjs documents; today same-named files go through
	// TeXlyre's replace/keep dialog.
	async importFromRemote(
		projectId: string | undefined,
		listing: SftpRemoteListing,
	): Promise<SftpImportSummary | null> {
		const target = this.getStoredTarget(projectId);
		if (!projectId || !target) {
			this.handleError(
				new Error(t('Open a project and choose an SFTP target first')),
				'import_error',
				t('SFTP import failed'),
			);
			return null;
		}

		const started = performance.now();
		this.updateStatus({ status: 'syncing', error: undefined });
		this.addActivity({
			type: 'import_start',
			message: t('Importing {count} files from {host}:{dir}...', {
				count: listing.files.length,
				host: target.host,
				dir: listing.remoteDir,
			}),
		});

		try {
			const project = await authService.getProjectById(projectId);
			if (!project?.docUrl) throw new Error(t('Could not load projects.'));
			const docId = project.docUrl.startsWith('yjs:')
				? project.docUrl.slice(4)
				: project.docUrl;
			if (!fileStoreService.isConnectedToProject(docId)) {
				await fileStoreService.initialize(`yjs:${docId}`);
			}

			const maxBytes = (this.settings.maxFileSize || 100) * 1024 * 1024;
			const skipped: string[] = [];
			const wanted = listing.files.filter((f) => {
				const p = `/${f.path}`;
				if (
					isTemporaryFile(p) ||
					this.shouldIgnoreFile(p) ||
					f.size > maxBytes
				) {
					skipped.push(p);
					return false;
				}
				return true;
			});

			const fileNodes: FileNode[] = [];
			let bytes = 0;
			await runPool(wanted, UPLOAD_CONCURRENCY, async (f) => {
				const r = await this.client.request<{
					content: string;
					sha256: string;
					mtime: number;
				}>('get', { remoteDir: target.remoteDir, path: `/${f.path}` });
				const data = base64ToBytes(r.content);
				if ((await sha256Hex(data)) !== r.sha256) {
					throw new Error(t('Checksum mismatch for {path}', { path: f.path }));
				}
				const name = f.path.slice(f.path.lastIndexOf('/') + 1);
				fileNodes.push({
					id: nanoid(),
					name,
					path: `/${f.path}`,
					type: 'file',
					content: data.buffer,
					lastModified: r.mtime * 1000,
					size: data.byteLength,
					mimeType: getMimeType(name),
					isBinary: isBinaryFile(name),
				});
				bytes += data.byteLength;
			});

			const dirPaths = new Set<string>();
			for (const node of fileNodes) {
				const segments = node.path.split('/').filter(Boolean).slice(0, -1);
				for (let i = 1; i <= segments.length; i++) {
					dirPaths.add(`/${segments.slice(0, i).join('/')}`);
				}
			}
			const dirNodes: FileNode[] = [...dirPaths].sort().map((path) => ({
				id: nanoid(),
				name: path.slice(path.lastIndexOf('/') + 1),
				path,
				type: 'directory',
				lastModified: Date.now(),
			}));
			fileNodes.sort((a, b) => a.path.localeCompare(b.path));

			try {
				await fileStoreService.batchStoreFiles([...dirNodes, ...fileNodes]);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === t('File operation cancelled by user')
				) {
					this.addActivity({
						type: 'import_error',
						message: t('Import cancelled'),
					});
					this.updateStatus({ status: 'idle' });
					return null;
				}
				throw error;
			}
			fileStorageEventEmitter.emitChange();

			this.addActivity({
				type: 'import_complete',
				message: t('Imported {count} files ({size}) from {host}:{dir}', {
					count: fileNodes.length,
					size: formatBytes(bytes),
					host: target.host,
					dir: listing.remoteDir,
				}),
			});

			const push = await this.push(projectId);
			return {
				remoteDir: listing.remoteDir,
				imported: fileNodes.length,
				bytes,
				skipped,
				ms: Math.round(performance.now() - started),
				push,
			};
		} catch (error) {
			moduleLog.error('SFTP import failed:', error);
			this.handleError(error, 'import_error', t('SFTP import failed'));
			return null;
		}
	}

	async push(
		projectId: string | undefined,
		force = false,
	): Promise<SftpPushSummary | null> {
		const target = this.getStoredTarget(projectId);
		if (!projectId || !target) {
			this.handleError(
				new Error(t('Open a project and choose an SFTP target first')),
				'backup_error',
				t('SFTP push failed'),
			);
			return null;
		}

		const started = performance.now();
		this.updateStatus({ status: 'syncing', error: undefined });
		this.addActivity({
			type: 'backup_start',
			message: force
				? t('Force-pushing to {host}:{dir}...', {
						host: target.host,
						dir: target.remoteDir,
					})
				: t('Pushing to {host}:{dir}...', {
						host: target.host,
						dir: target.remoteDir,
					}),
		});

		try {
			const project = await authService.getProjectById(projectId);
			if (!project) throw new Error(t('Could not load projects.'));

			const { entries, skipped } = await this.collectFiles(project);
			const info = await this.connectHost(target.host);

			const plan = await this.client.request<{
				planId: string;
				remoteDir: string;
				upload: string[];
				delete: string[];
			}>('plan', {
				remoteDir: target.remoteDir,
				manifest: entries.map((e) => ({ path: e.path, sha256: e.sha256 })),
				force,
			});

			const byRel = new Map(
				entries.map((e) => [e.path.replace(/^\/+/, ''), e]),
			);
			await runPool(plan.upload, UPLOAD_CONCURRENCY, async (rel) => {
				const entry = byRel.get(rel);
				if (!entry)
					throw new Error(`Planned file ${rel} is not in the project`);
				await this.client.request('put', {
					planId: plan.planId,
					path: entry.path,
					content: bytesToBase64(entry.bytes),
				});
			});

			const result = await this.client.request<
				Omit<SftpPushSummary, 'ms' | 'skipped'>
			>('commit', { planId: plan.planId });
			const summary: SftpPushSummary = {
				...result,
				skipped,
				ms: Math.round(performance.now() - started),
			};
			this.reportSummary(summary, target.host);
			this.updateStatus({
				isConnected: true,
				isEnabled: true,
				status: 'idle',
				lastSync: Date.now(),
				host: target.host,
				remoteDir: target.remoteDir,
				remoteHome: info.home,
			});
			return summary;
		} catch (error) {
			moduleLog.error('SFTP push failed:', error);
			this.handleError(error, 'backup_error', t('SFTP push failed'));
			return null;
		}
	}

	getStatus = (): SftpBackupStatus => ({ ...this.status });
	getActivities = (): BackupActivity[] => [...this.activities];
	getLastSummary = (): SftpPushSummary | null => this.lastSummary;

	addStatusListener = (
		cb: (status: SftpBackupStatus) => void,
	): (() => void) => {
		this.listeners.push(cb);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== cb);
		};
	};

	addActivityListener = (
		cb: (activities: BackupActivity[]) => void,
	): (() => void) => {
		this.activityListeners.push(cb);
		return () => {
			this.activityListeners = this.activityListeners.filter((l) => l !== cb);
		};
	};

	addSummaryListener = (
		cb: (summary: SftpPushSummary | null) => void,
	): (() => void) => {
		this.summaryListeners.push(cb);
		return () => {
			this.summaryListeners = this.summaryListeners.filter((l) => l !== cb);
		};
	};

	clearActivity = (id: string): void => {
		this.recordsContext?.removeRecord(
			this.getActivityRecordKey(),
			id,
			this.getActivityScopeOptions(),
		);
		this.activities = this.activities.filter((a) => a.id !== id);
		this.notifyActivityListeners();
	};

	clearAllActivities = (): void => {
		this.recordsContext?.clearRecords(
			this.getActivityRecordKey(),
			this.getActivityScopeOptions(),
		);
		this.activities = [];
		this.notifyActivityListeners();
	};

	private async ensureBridge(): Promise<void> {
		if (this.client.isOpen) return;
		const url = this.settings.bridgeUrl || SFTP_DEFAULT_BRIDGE_URL;
		const token = (this.settings.bridgeToken || '').trim();
		try {
			await this.client.open(url, token);
		} catch (error) {
			if (error instanceof BridgeRequestError && error.code === 'BAD_TOKEN') {
				throw new BridgeRequestError(
					'BAD_TOKEN',
					token
						? t(
								'The bridge rejected the token. Copy the token printed by the bridge into the SFTP settings.',
							)
						: t('Paste the token printed by the SFTP bridge first'),
				);
			}
			throw error;
		}
		this.updateStatus({ bridgeConnected: true });
	}

	private async connectHost(
		host: string,
	): Promise<{ home: string; user: string; hostName: string }> {
		await this.ensureBridge();
		const info = await this.client.request<{
			home: string;
			user: string;
			hostName: string;
			reused: boolean;
		}>('connect', { host });
		return info;
	}

	private async collectFiles(project: any): Promise<{
		entries: { path: string; bytes: Uint8Array<ArrayBuffer>; sha256: string }[];
		skipped: string[];
	}> {
		// Linked documents reach the file store on a 2 s debounce.
		await documentFileSyncService.flushAll();

		const { files, fileContents } =
			await this.dataService.serializeProjectFiles(project, false, false);
		const maxBytes = (this.settings.maxFileSize || 100) * 1024 * 1024;
		const byPath = new Map<
			string,
			{ path: string; bytes: Uint8Array<ArrayBuffer>; lastModified: number }
		>();
		const skipped: string[] = [];

		for (const file of files) {
			if (file.type !== 'file') continue;
			const content = fileContents.get(file.path);
			if (content === undefined) continue;
			if (isTemporaryFile(file.path) || this.shouldIgnoreFile(file.path))
				continue;

			const bytes =
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: new Uint8Array(content);
			if (bytes.byteLength > maxBytes) {
				skipped.push(file.path);
				this.addActivity({
					type: 'backup_error',
					message: t('Skipped file {path}: exceeds max size of {size}MB', {
						path: file.path,
						size: Math.round(maxBytes / 1024 / 1024),
					}),
				});
				continue;
			}

			// TeXlyre can allow duplicate names; the server cannot.
			const existing = byPath.get(file.path);
			if (existing) {
				skipped.push(file.path);
				if ((file.lastModified || 0) < existing.lastModified) continue;
			}
			byPath.set(file.path, {
				path: file.path,
				bytes,
				lastModified: file.lastModified || 0,
			});
		}

		const entries = await Promise.all(
			[...byPath.values()].map(async ({ path, bytes }) => ({
				path,
				bytes,
				sha256: await sha256Hex(bytes),
			})),
		);
		return { entries, skipped };
	}

	private reportSummary(summary: SftpPushSummary, host: string): void {
		this.lastSummary = summary;
		for (const l of this.summaryListeners) l(summary);

		this.addActivity({
			type: 'backup_complete',
			message: t(
				'Pushed {uploaded} files ({size}) to {host}:{dir}; {unchanged} unchanged, {deleted} deleted ({ms} ms)',
				{
					uploaded: summary.uploaded,
					size: formatBytes(summary.bytes),
					host,
					dir: summary.remoteDir,
					unchanged: summary.unchanged,
					deleted: summary.deleted,
					ms: summary.ms,
				},
			),
		});
		if (summary.adopted > 0) {
			this.addActivity({
				type: 'backup_complete',
				message: t(
					'{count} server files already matched the project and are now tracked',
					{ count: summary.adopted },
				),
			});
		}
		if (summary.remoteEdited.length > 0) {
			this.addActivity({
				type: 'import_start',
				message: t('Kept server-side edits (unchanged locally): {paths}', {
					paths: summary.remoteEdited.slice(0, 5).join(', '),
				}),
			});
		}
		if (summary.conflicts.length > 0) {
			this.addActivity({
				type: 'backup_error',
				message: t(
					'Not overwritten ({count}): {list}. Use Force push to overwrite.',
					{
						count: summary.conflicts.length,
						list: summary.conflicts
							.slice(0, 5)
							.map((c) => `${c.path} ${CONFLICT_REASONS[c.reason] || c.reason}`)
							.join('; '),
					},
				),
			});
		}
	}

	private shouldIgnoreFile(filePath: string): boolean {
		for (const pattern of this.settings.ignorePatterns || []) {
			const trimmed = pattern.trim();
			if (!trimmed) continue;
			const regex = new RegExp(
				`^${trimmed.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
			);
			const fileName = filePath.split('/').pop() || '';
			if (regex.test(fileName) || regex.test(filePath)) return true;
		}
		return false;
	}

	// Targets are not secrets (host alias + folder), so they live in
	// localStorage rather than the password-protected secrets store.
	// TODO: move into project metadata so targets follow account export.
	private loadTargets(): Record<string, SftpTarget> {
		try {
			return JSON.parse(localStorage.getItem(TARGETS_STORAGE_KEY) || '{}');
		} catch {
			return {};
		}
	}

	private saveTarget(
		projectId: string | undefined,
		target: SftpTarget | null,
	): void {
		try {
			const targets = this.loadTargets();
			const key = projectId || 'global';
			if (target) targets[key] = target;
			else delete targets[key];
			localStorage.setItem(TARGETS_STORAGE_KEY, JSON.stringify(targets));
		} catch (error) {
			moduleLog.warn('Could not persist SFTP target:', error);
		}
	}

	private hydrateTargetStatus(): void {
		const target = this.getStoredTarget(this.currentProjectId);
		this.updateStatus({
			isConnected: !!target,
			isEnabled: !!target,
			host: target?.host,
			remoteDir: target?.remoteDir,
		});
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private handleError(
		error: unknown,
		type: 'backup_error' | 'import_error',
		prefix: string,
	): void {
		const message = this.errorMessage(error);
		this.addActivity({ type, message: `${prefix}: ${message}` });
		this.updateStatus({ status: 'error', error: message });
	}

	private updateStatus(patch: Partial<SftpBackupStatus>): void {
		this.status = { ...this.status, ...patch };
		for (const l of this.listeners) l(this.getStatus());
	}

	private getActivityRecordKey(): string {
		return `${PLUGIN_ID}-activity`;
	}

	private getActivityScopeOptions() {
		return {
			scope: this.currentProjectId ? ('project' as const) : ('global' as const),
			projectId: this.currentProjectId,
			maxEntries: this.settings.activityHistoryLimit || 50,
		};
	}

	private hydrateActivities(): void {
		if (!this.recordsContext) return;
		const entries = this.recordsContext.listRecords<ActivityInput>(
			this.getActivityRecordKey(),
			{
				scope: this.currentProjectId ? 'project' : 'global',
				projectId: this.currentProjectId,
			},
		);
		this.activities = entries.map((entry) => ({
			id: entry.id,
			timestamp: entry.timestamp,
			...entry.data,
		}));
		this.notifyActivityListeners();
	}

	private addActivity(activity: ActivityInput): void {
		const entry = this.recordsContext?.appendRecord(
			this.getActivityRecordKey(),
			activity,
			this.getActivityScopeOptions(),
		);
		const full: BackupActivity = entry
			? { id: entry.id, timestamp: entry.timestamp, ...activity }
			: {
					id: Math.random().toString(36).substring(2),
					timestamp: Date.now(),
					...activity,
				};
		const limit = this.settings.activityHistoryLimit || 50;
		this.activities = [...this.activities.slice(-limit + 1), full];
		this.notifyActivityListeners();
	}

	private notifyActivityListeners(): void {
		for (const l of this.activityListeners) l([...this.activities]);
	}
}

export const sftpBackupService = new SftpBackupService();
