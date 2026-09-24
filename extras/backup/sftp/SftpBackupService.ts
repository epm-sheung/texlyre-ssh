// extras/backup/sftp/SftpBackupService.ts
// SFTP sync through the local texlyre-sftp-bridge. Keeps the plain project
// tree (main.tex, figures/, ...) identical to a server folder: server changes
// come in, TeXlyre edits go out, and the server wins when both changed (the
// local version is kept under .texlyre/sftp-conflicts/). After the first
// manual sync of a project it also runs in the background while that
// project is open. Force push is the explicit "TeXlyre wins" override.
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
import {
	SFTP_DEFAULT_AUTO_SYNC_SECONDS,
	SFTP_DEFAULT_BRIDGE_URL,
	SFTP_DEFAULT_IMPORT_EXCLUDE,
} from './settings';
import { applySyncPlan, type SyncPlan } from './syncApply';
import { collabService } from '@/services/CollabService';
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
const PAIRED_TOKEN_KEY = 'texlyre-sftp-bridge-token';
const PAIR_PARAM = 'sftp-bridge-token';

// The Start TeXlyre launchers open TeXlyre with ?sftp-bridge-token=… so the bridge
// token never has to be copied by hand. Keep it and drop it from the URL.
function capturePairedToken(): void {
	try {
		const url = new URL(window.location.href);
		const token = url.searchParams.get(PAIR_PARAM);
		if (!token) return;
		localStorage.setItem(PAIRED_TOKEN_KEY, token);
		url.searchParams.delete(PAIR_PARAM);
		window.history.replaceState(window.history.state, '', url.toString());
	} catch {
		// No window/localStorage (tests, private mode): manual token still works.
	}
}
capturePairedToken();
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
	autoSync?: boolean;
	autoSyncSeconds?: number;
}

const splitList = (value: unknown): string[] | undefined =>
	typeof value === 'string'
		? value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: undefined;

// Background sync runs without the SFTP modal mounted, so read the saved
// TeXlyre settings directly (same storage key as SettingsContext).
function readStoredSettings(): SftpBackupSettings {
	try {
		const userId = localStorage.getItem('texlyre-current-user');
		const raw = localStorage.getItem(
			userId ? `texlyre-user-${userId}-settings` : 'texlyre-settings',
		);
		const s = raw ? JSON.parse(raw) : {};
		const pick = <T>(id: string, type: string): T | undefined =>
			typeof s[id] === type ? (s[id] as T) : undefined;
		return {
			bridgeUrl: pick<string>('sftp-backup-bridge-url', 'string'),
			bridgeToken: pick<string>('sftp-backup-bridge-token', 'string'),
			ignorePatterns: splitList(s['sftp-backup-ignore-patterns']),
			importExclude:
				splitList(s['sftp-backup-import-exclude']) ??
				splitList(SFTP_DEFAULT_IMPORT_EXCLUDE),
			maxFileSize: pick<number>('sftp-backup-max-file-size', 'number'),
			activityHistoryLimit: pick<number>(
				'sftp-backup-activity-history-limit',
				'number',
			),
			autoSync: pick<boolean>('sftp-backup-auto-sync', 'boolean') ?? true,
			autoSyncSeconds:
				pick<number>('sftp-backup-auto-sync-interval', 'number') ??
				SFTP_DEFAULT_AUTO_SYNC_SECONDS,
		};
	} catch {
		return {};
	}
}

// Never synced in either direction (matches isTemporaryFile).
const ALWAYS_EXCLUDE = [
	'.texlyre',
	'.git',
	'.svn',
	'node_modules',
	'.DS_Store',
];

// Background sync pauses instead of deleting more files than this in a round.
const MAX_AUTO_DELETES = 5;

export interface SftpSyncPreview {
	host: string;
	remoteDir: string;
	download: number;
	upload: number;
	deleteLocal: number;
	deleteRemote: number;
	serverWins: string[];
}

export interface SftpSummary {
	kind: 'sync' | 'push';
	remoteDir: string;
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	unchanged: number;
	adopted: number;
	serverWins: { path: string; reason: string }[];
	backups: string[];
	skipped: string[];
	conflicts: { path: string; reason: string }[];
	remoteEdited: string[];
	ms: number;
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
	// Set by the first manual "Sync now" for this project; background sync
	// never starts on a project the user hasn't synced by hand.
	autoSync?: boolean;
}

export interface SftpBackupStatus extends BackupStatus {
	host?: string;
	remoteDir?: string;
	remoteHome?: string;
	bridgeConnected?: boolean;
	// Background sync: running, waiting for a manual login, or turned off.
	autoSync?: 'on' | 'waiting-login' | 'waiting-confirm' | 'off';
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
	private summaryListeners: Array<(summary: SftpSummary | null) => void> = [];
	private lastSummary: SftpSummary | null = null;

	// Saved settings, overridden by the live values the modal passes in.
	private settings: SftpBackupSettings = {};
	private uiSettings: SftpBackupSettings = {};
	// One sync/push/import at a time, manual or background.
	private busy = false;
	private autoTimer: ReturnType<typeof setInterval> | null = null;
	private lastAutoAttempt = 0;
	private lastAutoError = '';
	private reportedTooLarge = new Set<string>();
	private recordsContext: RecordsContextType | null = null;
	private currentProjectId: string | undefined;
	private promptHandler:
		| ((prompt: BridgePrompt) => Promise<string[] | null>)
		| null = null;

	private onTokenAccepted: ((token: string) => void) | null = null;

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
		this.uiSettings = { ...settings };
		this.refreshSettings();
	}

	private refreshSettings(): void {
		const accepted = this.settings.bridgeToken;
		this.settings = { ...readStoredSettings(), ...this.uiSettings };
		// Keep a token the bridge accepted this session (see ensureBridge).
		if (accepted && !this.uiSettings.bridgeToken)
			this.settings.bridgeToken = accepted;
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
		await this.sync(projectId ?? this.currentProjectId);
	}

	// Two-way sync: server changes come in, TeXlyre edits go out. When a
	// file changed on both sides the server version wins and the local one
	// is saved under .texlyre/sftp-conflicts/. With `auto`, never prompts
	// for a login and never touches a project that isn't open.
	async sync(
		projectId: string | undefined,
		{
			auto = false,
			confirm,
		}: {
			auto?: boolean;
			// Manual syncs: asked before deletions beyond the safety limit or
			// before server versions replace local edits.
			confirm?: (preview: SftpSyncPreview) => Promise<boolean>;
		} = {},
	): Promise<SftpSummary | null> {
		const target = this.getStoredTarget(projectId);
		if (!projectId || !target) {
			if (!auto) {
				this.handleError(
					new Error(t('Open a project and choose an SFTP target first')),
					'backup_error',
					t('SFTP sync failed'),
				);
			}
			return null;
		}
		if (this.busy) return null;
		this.busy = true;
		const started = performance.now();
		try {
			this.refreshSettings();
			const project = await authService.getProjectById(projectId);
			if (!project?.docUrl) throw new Error(t('Could not load projects.'));
			const docId = project.docUrl.startsWith('yjs:')
				? project.docUrl.slice(4)
				: project.docUrl;

			if (auto) {
				if (!fileStoreService.isConnectedToProject(docId)) return null;
				await this.ensureBridge();
				const { active } = await this.client.request<{ active: boolean }>(
					'session',
					{ host: target.host },
				);
				if (!active) {
					this.updateStatus({ autoSync: 'waiting-login' });
					return null;
				}
			} else {
				this.addActivity({
					type: 'backup_start',
					message: t('Syncing with {host}:{dir}...', {
						host: target.host,
						dir: target.remoteDir,
					}),
				});
			}
			this.updateStatus({ status: 'syncing', error: undefined });

			const { entries, tooLarge } = await this.collectFiles(project);
			const info = await this.connectHost(target.host);
			const exclude = [
				...(this.settings.importExclude || []),
				...(this.settings.ignorePatterns || []),
				...ALWAYS_EXCLUDE,
				// Skipped for size, not deleted: keep the server copy.
				...tooLarge.map((p) => p.replace(/^\/+/, '')),
			];
			const plan = await this.client.request<
				SyncPlan & { remoteDir: string; unchanged: number; adopted: number }
			>('syncPlan', {
				remoteDir: target.remoteDir,
				manifest: entries.map((e) => ({ path: e.path, sha256: e.sha256 })),
				exclude,
			});

			const preview: SftpSyncPreview = {
				host: target.host,
				remoteDir: plan.remoteDir,
				download: plan.download.length,
				upload: plan.upload.length,
				deleteLocal:
					plan.deleteLocal.length +
					plan.serverWins.filter((w) => w.action === 'deleteLocal').length,
				deleteRemote: plan.deleteRemote.length,
				serverWins: plan.serverWins.map((w) => w.path),
			};
			// A purge or an accidental mass delete on either side must not
			// silently propagate: background sync pauses, manual sync asks.
			const manyDeletes =
				preview.deleteLocal > MAX_AUTO_DELETES ||
				preview.deleteRemote > MAX_AUTO_DELETES;
			if (auto && manyDeletes) {
				this.updateStatus({ status: 'idle', autoSync: 'waiting-confirm' });
				if (this.lastAutoError !== 'many-deletes') {
					this.lastAutoError = 'many-deletes';
					this.addActivity({
						type: 'backup_error',
						message: t(
							'Auto-sync paused: it would delete {local} files here and {remote} on the server. Click "Sync now" to review.',
							{ local: preview.deleteLocal, remote: preview.deleteRemote },
						),
					});
				}
				return null;
			}
			if (
				!auto &&
				confirm &&
				(manyDeletes || preview.serverWins.length > 0) &&
				!(await confirm(preview))
			) {
				this.updateStatus({ status: 'idle' });
				this.addActivity({
					type: 'backup_error',
					message: t('Sync cancelled'),
				});
				return null;
			}

			const localFiles = new Map(
				(await fileStoreService.getAllFiles(false)).map((f) => [f.path, f]),
			);
			const collected = new Map(
				entries.map((e) => [e.path.replace(/^\/+/, ''), e.bytes]),
			);
			const applied = await applySyncPlan(plan, localFiles, collected, {
				getRemote: async (rel) => {
					const r = await this.client.request<{
						content: string;
						sha256: string;
						mtime: number;
					}>('get', { remoteDir: target.remoteDir, path: `/${rel}` });
					const bytes = base64ToBytes(r.content);
					if ((await sha256Hex(bytes)) !== r.sha256) {
						throw new Error(t('Checksum mismatch for {path}', { path: rel }));
					}
					return { bytes, sha256: r.sha256, mtime: r.mtime };
				},
				putRemote: async (rel, bytes) => {
					await this.client.request('put', {
						planId: plan.planId,
						path: `/${rel}`,
						content: bytesToBase64(bytes),
					});
				},
				storeFiles: async (nodes) => {
					await fileStoreService.batchStoreFiles(nodes, {
						showConflictDialog: false,
						preserveTimestamp: true,
					});
				},
				deleteLocalFile: async (file) => {
					await fileStoreService.deleteFile(file.id, {
						showDeleteDialog: false,
						allowLinkedFileDelete: true,
					});
				},
				updateDocument: (documentId, updater) =>
					collabService.updateDocumentContent(docId, documentId, updater),
				newId: () => nanoid(),
				mimeType: getMimeType,
				isBinary: isBinaryFile,
				now: () => Date.now(),
			});

			const result = await this.client.request<{
				remoteDir: string;
				uploaded: number;
				downloaded: number;
				deletedRemote: number;
				deletedLocal: number;
				unchanged: number;
				adopted: number;
			}>('commit', {
				planId: plan.planId,
				downloaded: applied.downloaded,
				deletedLocal: applied.deletedLocal,
			});
			if (applied.downloaded.length || applied.deletedLocal.length) {
				fileStorageEventEmitter.emitChange();
			}

			const summary: SftpSummary = {
				kind: 'sync',
				remoteDir: result.remoteDir,
				uploaded: result.uploaded,
				downloaded: result.downloaded,
				deletedLocal: result.deletedLocal,
				deletedRemote: result.deletedRemote,
				unchanged: result.unchanged,
				adopted: result.adopted,
				serverWins: plan.serverWins.map((w) => ({
					path: w.path,
					reason: w.reason,
				})),
				backups: applied.backups,
				skipped: [...applied.skipped, ...tooLarge],
				conflicts: [],
				remoteEdited: [],
				ms: Math.round(performance.now() - started),
			};
			const changed =
				summary.uploaded +
					summary.downloaded +
					summary.deletedLocal +
					summary.deletedRemote >
				0;
			if (!auto || changed) this.reportSyncSummary(summary, target.host);
			if (!auto && !target.autoSync) {
				this.saveTarget(projectId, { ...target, autoSync: true });
			}
			this.lastAutoError = '';
			this.updateStatus({
				isConnected: true,
				isEnabled: true,
				status: 'idle',
				lastSync: Date.now(),
				host: target.host,
				remoteDir: target.remoteDir,
				remoteHome: info.home,
				autoSync: this.settings.autoSync === false ? 'off' : 'on',
			});
			return summary;
		} catch (error) {
			moduleLog.error('SFTP sync failed:', error);
			const message = this.errorMessage(error);
			if (!auto || message !== this.lastAutoError) {
				this.handleError(error, 'backup_error', t('SFTP sync failed'));
			} else {
				this.updateStatus({ status: 'error', error: message });
			}
			if (auto) this.lastAutoError = message;
			return null;
		} finally {
			this.busy = false;
		}
	}

	// Background sync for the project open in the editor.
	startAutoSync(): void {
		if (this.autoTimer || typeof window === 'undefined') return;
		this.autoTimer = setInterval(() => void this.autoTick(), 5000);
	}

	private async autoTick(): Promise<void> {
		if (this.busy) return;
		this.refreshSettings();
		if (this.settings.autoSync === false) {
			if (this.status.autoSync !== 'off')
				this.updateStatus({ autoSync: 'off' });
			return;
		}
		const intervalMs =
			Math.max(
				15,
				this.settings.autoSyncSeconds || SFTP_DEFAULT_AUTO_SYNC_SECONDS,
			) * 1000;
		if (Date.now() - this.lastAutoAttempt < intervalMs) return;
		const projectId = sessionStorage.getItem('currentProjectId') || undefined;
		if (!projectId || !this.getStoredTarget(projectId)?.autoSync) return;
		this.lastAutoAttempt = Date.now();
		await this.sync(projectId, { auto: true });
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

		if (this.busy) {
			this.handleError(
				new Error(t('A sync is already running; try again in a moment')),
				'backup_error',
				t('SFTP push failed'),
			);
			return null;
		}
		this.busy = true;
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
		} finally {
			this.busy = false;
		}
	}

	getStatus = (): SftpBackupStatus => ({ ...this.status });
	getActivities = (): BackupActivity[] => [...this.activities];
	getLastSummary = (): SftpSummary | null => this.lastSummary;

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
		cb: (summary: SftpSummary | null) => void,
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
		// The token typed in Settings first, then the one the launcher passed in;
		// whichever the bridge accepts is written back to Settings.
		const candidates = [
			...new Set(
				[
					(this.settings.bridgeToken || '').trim(),
					this.getPairedToken(),
				].filter(Boolean),
			),
		];
		for (const token of candidates.length ? candidates : ['']) {
			try {
				await this.client.open(url, token);
				this.updateStatus({ bridgeConnected: true });
				if (token && token !== (this.settings.bridgeToken || '').trim()) {
					this.settings.bridgeToken = token;
					this.onTokenAccepted?.(token);
				}
				return;
			} catch (error) {
				if (error instanceof BridgeRequestError && error.code === 'BAD_TOKEN') {
					continue;
				}
				throw error;
			}
		}
		throw new BridgeRequestError(
			'BAD_TOKEN',
			t(
				'The bridge rejected the token. Open TeXlyre with the Start TeXlyre launcher (it passes the token automatically), or paste the token shown in the bridge window into Settings → Backup → SFTP.',
			),
		);
	}

	getPairedToken(): string {
		try {
			return (localStorage.getItem(PAIRED_TOKEN_KEY) || '').trim();
		} catch {
			return '';
		}
	}

	// Lets the modal save a token that worked into Settings.
	setTokenAcceptedHandler(handler: ((token: string) => void) | null): void {
		this.onTokenAccepted = handler;
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
		tooLarge: string[];
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
		const tooLarge: string[] = [];

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
				tooLarge.push(file.path);
				// Once per file per session: background sync runs every minute.
				if (!this.reportedTooLarge.has(file.path)) {
					this.reportedTooLarge.add(file.path);
					this.addActivity({
						type: 'backup_error',
						message: t('Skipped file {path}: exceeds max size of {size}MB', {
							path: file.path,
							size: Math.round(maxBytes / 1024 / 1024),
						}),
					});
				}
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
		return { entries, skipped, tooLarge };
	}

	private emitSummary(summary: SftpSummary): void {
		this.lastSummary = summary;
		for (const l of this.summaryListeners) l(summary);
	}

	private reportSyncSummary(summary: SftpSummary, host: string): void {
		this.emitSummary(summary);
		this.addActivity({
			type: 'backup_complete',
			message: t(
				'Synced with {host}:{dir}: {down} in, {up} out, {delLocal} removed here, {delRemote} removed on server ({ms} ms)',
				{
					host,
					dir: summary.remoteDir,
					down: summary.downloaded,
					up: summary.uploaded,
					delLocal: summary.deletedLocal,
					delRemote: summary.deletedRemote,
					ms: summary.ms,
				},
			),
		});
		if (summary.serverWins.length > 0) {
			this.addActivity({
				type: 'import_start',
				message: t(
					'Changed on both sides, kept the server version: {paths}. Your versions are in {dir}',
					{
						paths: summary.serverWins
							.slice(0, 5)
							.map((w) => w.path)
							.join(', '),
						dir:
							summary.backups[0]?.replace(/\/[^/]*$/, '') ||
							'.texlyre/sftp-conflicts',
					},
				),
			});
		}
		if (summary.skipped.length > 0) {
			this.addActivity({
				type: 'import_start',
				message: t(
					'Left for the next sync (edited while syncing or too large): {paths}',
					{
						paths: summary.skipped.slice(0, 5).join(', '),
					},
				),
			});
		}
	}

	private reportSummary(summary: SftpPushSummary, host: string): void {
		this.emitSummary({
			kind: 'push',
			remoteDir: summary.remoteDir,
			uploaded: summary.uploaded,
			downloaded: 0,
			deletedLocal: 0,
			deletedRemote: summary.deleted,
			unchanged: summary.unchanged,
			adopted: summary.adopted,
			serverWins: [],
			backups: [],
			skipped: summary.skipped,
			conflicts: summary.conflicts,
			remoteEdited: summary.remoteEdited,
			ms: summary.ms,
		});

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
sftpBackupService.startAutoSync();
