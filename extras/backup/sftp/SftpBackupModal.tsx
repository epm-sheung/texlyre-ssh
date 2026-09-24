// extras/backup/sftp/SftpBackupModal.tsx
import { t } from '@/i18n';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
	ChevronUpIcon,
	DisconnectIcon,
	FolderIcon,
	GitPushIcon,
	ImportIcon,
	SettingsIcon,
	TrashIcon,
} from '@/components/common/Icons';
import Modal from '@/components/common/Modal';
import SettingsModal from '@/components/settings/SettingsModal';
import { useAuth } from '@/hooks/useAuth';
import { useRecords } from '@/hooks/useRecords';
import { useSettings } from '@/hooks/useSettings';
import { formatDate } from '@/utils/dateUtils';
import { SftpIcon } from './Icon';
import { SFTP_DEFAULT_BRIDGE_URL } from './settings';
import {
	type SftpDirListing,
	type SftpPushSummary,
	type SftpTarget,
	sftpBackupService,
} from './SftpBackupService';
import type { BridgePrompt } from './SftpBridgeClient';
import './styles.css';

interface SftpBackupModalProps {
	isOpen: boolean;
	onClose: () => void;
	currentProjectId?: string | null;
	isInEditor?: boolean;
}

interface PendingPrompt {
	data: BridgePrompt;
	resolve: (answers: string[] | null) => void;
}

const joinRemote = (dir: string, name: string): string =>
	dir === '/' ? `/${name}` : `${dir}/${name}`;

const SftpBackupModal: React.FC<SftpBackupModalProps> = ({
	isOpen,
	onClose,
	currentProjectId,
	isInEditor = false,
}) => {
	const [showSettings, setShowSettings] = useState(false);
	const [status, setStatus] = useState(sftpBackupService.getStatus());
	const [activities, setActivities] = useState(
		sftpBackupService.getActivities(),
	);
	const [summary, setSummary] = useState<SftpPushSummary | null>(
		sftpBackupService.getLastSummary(),
	);
	const [isOperating, setIsOperating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showConnectionFlow, setShowConnectionFlow] = useState(false);
	const [hosts, setHosts] = useState<string[]>([]);
	const [hostInput, setHostInput] = useState('');
	const [remoteDirInput, setRemoteDirInput] = useState('');
	const [connectStep, setConnectStep] = useState<'server' | 'folder'>('server');
	const [browse, setBrowse] = useState<SftpDirListing | null>(null);
	const [recent, setRecent] = useState<SftpTarget[]>([]);
	const [currentProjectName, setCurrentProjectName] = useState('');
	const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(
		null,
	);
	const [promptAnswers, setPromptAnswers] = useState<string[]>([]);

	const { getProjectById } = useAuth();
	const records = useRecords();
	const { getSetting } = useSettings();

	const projectId = isInEditor ? (currentProjectId ?? undefined) : undefined;

	useEffect(() => {
		sftpBackupService.setSettings({
			bridgeUrl:
				(getSetting('sftp-backup-bridge-url')?.value as string) ||
				SFTP_DEFAULT_BRIDGE_URL,
			bridgeToken:
				(getSetting('sftp-backup-bridge-token')?.value as string) || '',
			ignorePatterns: (
				(getSetting('sftp-backup-ignore-patterns')?.value as string) || ''
			)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
			importExclude: (
				(getSetting('sftp-backup-import-exclude')?.value as string) || ''
			)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
			maxFileSize:
				(getSetting('sftp-backup-max-file-size')?.value as number) || 100,
			activityHistoryLimit:
				(getSetting('sftp-backup-activity-history-limit')?.value as number) ||
				50,
		});
	}, [getSetting]);

	useEffect(() => {
		sftpBackupService.setRecordsContext(records);
	}, [records]);

	useEffect(() => {
		sftpBackupService.setCurrentProjectId(projectId);
	}, [projectId]);

	useEffect(() => {
		const unsubscribeStatus = sftpBackupService.addStatusListener(setStatus);
		const unsubscribeActivities =
			sftpBackupService.addActivityListener(setActivities);
		const unsubscribeSummary = sftpBackupService.addSummaryListener(setSummary);
		return () => {
			unsubscribeStatus();
			unsubscribeActivities();
			unsubscribeSummary();
		};
	}, []);

	// Passphrase / MFA prompts from the bridge are answered in this modal.
	useEffect(() => {
		if (!isOpen) return;
		sftpBackupService.setPromptHandler(
			(data) =>
				new Promise((resolve) => {
					setPromptAnswers(data.prompts.map(() => ''));
					setPendingPrompt({ data, resolve });
				}),
		);
		return () => sftpBackupService.setPromptHandler(null);
	}, [isOpen]);

	useEffect(() => {
		if (!projectId) return;
		getProjectById(projectId)
			.then((project) => setCurrentProjectName(project?.name || ''))
			.catch(() => setCurrentProjectName(''));
	}, [projectId, getProjectById]);

	const handleAsyncOperation = async (operation: () => Promise<void>) => {
		if (isOperating) return;
		setIsOperating(true);
		setError(null);
		try {
			await operation();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsOperating(false);
		}
	};

	const answerPrompt = useCallback(
		(answers: string[] | null) => {
			pendingPrompt?.resolve(answers);
			setPendingPrompt(null);
			setPromptAnswers([]);
		},
		[pendingPrompt],
	);

	const handleOpenConnectionFlow = () =>
		handleAsyncOperation(async () => {
			const stored = sftpBackupService.getStoredTarget(projectId);
			setHostInput(stored?.host || '');
			setRemoteDirInput(stored?.remoteDir || '');
			setBrowse(null);
			setConnectStep('server');
			setRecent(sftpBackupService.getRecentTargets());
			setShowConnectionFlow(true);
			const access = await sftpBackupService.requestAccess();
			if (!access.success) {
				setError(access.error || t('Cannot reach the SFTP bridge'));
				return;
			}
			setHosts(await sftpBackupService.listHosts());
		});

	const loadDir = async (dir: string) => {
		const listing = await sftpBackupService.browse(dir);
		setBrowse(listing);
		setRemoteDirInput(listing.path);
	};

	const handleConnectServer = () =>
		handleAsyncOperation(async () => {
			const host = hostInput.trim();
			if (!host) return;
			await sftpBackupService.connectServer(host);
			const stored = sftpBackupService.getStoredTarget(projectId);
			setConnectStep('folder');
			try {
				await loadDir(
					stored?.host === host && stored.remoteDir ? stored.remoteDir : '~',
				);
			} catch {
				await loadDir('~');
			}
		});

	const handleBrowse = (dir: string) =>
		handleAsyncOperation(async () => {
			await loadDir(dir);
		});

	const handleUseFolder = () =>
		handleAsyncOperation(async () => {
			const host = hostInput.trim();
			const remoteDir = remoteDirInput.trim();
			if (!host || !remoteDir) return;
			const ok = await sftpBackupService.connect(
				{ host, remoteDir },
				projectId,
			);
			if (ok) setShowConnectionFlow(false);
			else setError(sftpBackupService.getStatus().error || null);
		});

	const handlePickRecent = (target: SftpTarget) =>
		handleAsyncOperation(async () => {
			setHostInput(target.host);
			setRemoteDirInput(target.remoteDir);
			const ok = await sftpBackupService.connect(target, projectId);
			if (ok) setShowConnectionFlow(false);
			else setError(sftpBackupService.getStatus().error || null);
		});

	const handlePush = (force: boolean) =>
		handleAsyncOperation(async () => {
			if (
				force &&
				!window.confirm(
					t(
						'Force push overwrites files that were edited on the server, and files TeXlyre did not create. Continue?',
					),
				)
			) {
				return;
			}
			await sftpBackupService.push(projectId, force);
			const next = sftpBackupService.getStatus();
			if (next.status === 'error') setError(next.error || null);
		});

	const handleImport = () =>
		handleAsyncOperation(async () => {
			const listing = await sftpBackupService.previewImport(projectId);
			const excluded = listing.skipped.excluded;
			if (
				!window.confirm(
					t(
						'Import {count} files ({size} MB) from {host}:{dir} into this project?\n\nExcluded: {excluded}\n\nSame-named files already in the project will ask before being replaced. Afterwards TeXlyre records the server state; nothing is uploaded unless this project has files that are not on the server.',
						{
							count: listing.files.length,
							size: (listing.totalBytes / 1024 / 1024).toFixed(1),
							host: status.host,
							dir: listing.remoteDir,
							excluded: excluded.length
								? `${excluded.slice(0, 8).join(', ')}${excluded.length > 8 ? ', ...' : ''}`
								: t('nothing'),
						},
					),
				)
			) {
				return;
			}
			await sftpBackupService.importFromRemote(projectId, listing);
			const next = sftpBackupService.getStatus();
			if (next.status === 'error') setError(next.error || null);
		});

	const handleDisconnect = () =>
		handleAsyncOperation(async () => {
			await sftpBackupService.disconnect(projectId);
			setSummary(null);
		});

	const getActivityColor = (type: string) =>
		({
			backup_error: '#dc3545',
			import_error: '#dc3545',
			backup_complete: '#28a745',
			import_complete: '#28a745',
			backup_start: '#007bff',
			import_start: '#6f42c1',
		})[type] || '#6c757d';

	const renderPrompt = () => {
		if (!pendingPrompt) return null;
		const { data } = pendingPrompt;
		return (
			<form
				className='connection-flow sftp-auth-prompt'
				onSubmit={(e) => {
					e.preventDefault();
					answerPrompt(promptAnswers);
				}}
			>
				<h3>{data.title || t('Authentication required')}</h3>
				{data.instructions && (
					<pre className='sftp-prompt-instructions'>{data.instructions}</pre>
				)}
				{data.prompts.map((p, i) => (
					<div key={`${data.promptId}-${i}`}>
						<label htmlFor={`sftp-prompt-${data.promptId}-${i}`}>
							{p.prompt}
						</label>
						<input
							id={`sftp-prompt-${data.promptId}-${i}`}
							type={p.echo ? 'text' : 'password'}
							autoComplete='off'
							value={promptAnswers[i] || ''}
							onChange={(e) => {
								const next = [...promptAnswers];
								next[i] = e.target.value;
								setPromptAnswers(next);
							}}
						/>
					</div>
				))}
				<div className='button-group'>
					<button type='submit' className='button primary'>
						{t('Submit')}
					</button>
					<button
						type='button'
						className='button secondary'
						onClick={() => answerPrompt(null)}
					>
						{t('Cancel')}
					</button>
				</div>
			</form>
		);
	};

	const renderSummary = () => {
		if (!summary) return null;
		return (
			<div className='sftp-summary'>
				<div className='sftp-summary-counts'>
					<span>
						<strong>{summary.uploaded}</strong> {t('uploaded')}
					</span>
					<span>
						<strong>{summary.unchanged}</strong> {t('unchanged')}
					</span>
					<span>
						<strong>{summary.deleted}</strong> {t('deleted')}
					</span>
					{summary.adopted > 0 && (
						<span>
							<strong>{summary.adopted}</strong> {t('adopted')}
						</span>
					)}
					<span>
						<strong>{summary.conflicts.length}</strong> {t('conflicts')}
					</span>
					<span className='sftp-summary-time'>{summary.ms} ms</span>
				</div>
				{summary.conflicts.length > 0 && (
					<ul className='sftp-conflicts'>
						{summary.conflicts.map((c) => (
							<li key={c.path}>
								<code>{c.path}</code> <span>{c.reason}</span>
							</li>
						))}
					</ul>
				)}
				{summary.remoteEdited.length > 0 && (
					<div className='sftp-remote-edited'>
						{t('Kept server-side edits:')}{' '}
						{summary.remoteEdited.map((p) => (
							<code key={p}>{p}</code>
						))}
					</div>
				)}
			</div>
		);
	};

	const connected = status.isConnected && !!status.host;

	return (
		<>
			<Modal
				isOpen={isOpen}
				onClose={onClose}
				title={t('SFTP Backup')}
				icon={SftpIcon}
				size='medium'
				headerActions={
					<button
						className='modal-close-button'
						onClick={() => setShowSettings(true)}
						title={t('SFTP Backup Settings')}
					>
						<SettingsIcon />
					</button>
				}
			>
				<div className='backup-modal'>
					{error && <div className='error-message'>{error}</div>}

					{renderPrompt()}

					{!projectId && (
						<div className='sftp-no-project'>
							{t('Open a project in the editor to push it over SFTP.')}
						</div>
					)}

					{projectId && showConnectionFlow && connectStep === 'server' && (
						<div className='connection-flow'>
							<h3>{t('Connect to a server')}</h3>
							{recent.length > 0 && (
								<>
									<label>{t('Recent:')}</label>
									<div className='sftp-recent'>
										{recent.map((r) => (
											<button
												type='button'
												key={`${r.host}:${r.remoteDir}`}
												className='button secondary small'
												onClick={() => handlePickRecent(r)}
												disabled={isOperating}
												title={`${r.host}:${r.remoteDir}`}
											>
												{r.host}:
												{r.remoteDir.split('/').filter(Boolean).pop() || '/'}
											</button>
										))}
									</div>
								</>
							)}
							<label htmlFor='sftp-host'>{t('SSH host:')}</label>
							<input
								id='sftp-host'
								type='text'
								list='sftp-host-options'
								value={hostInput}
								placeholder={t('my-server or user@host:22')}
								onChange={(e) => {
									setError(null);
									setHostInput(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === 'Enter') handleConnectServer();
								}}
								disabled={isOperating}
							/>
							<datalist id='sftp-host-options'>
								{hosts.map((h) => (
									<option key={h} value={h} />
								))}
							</datalist>
							<p className='sftp-hint'>
								{t(
									'A host alias from your ~/.ssh/config (suggested as you type) or user@host[:port]. Keys, ProxyJump and MFA prompts work as in ssh.',
								)}
							</p>
							<div className='button-group'>
								<button
									type='button'
									className='button primary'
									onClick={handleConnectServer}
									disabled={isOperating || !hostInput.trim()}
								>
									{isOperating ? t('Connecting...') : t('Connect')}
								</button>
								<button
									type='button'
									className='button secondary'
									onClick={() => setShowConnectionFlow(false)}
									disabled={isOperating}
								>
									{t('Cancel')}
								</button>
							</div>
						</div>
					)}

					{projectId && showConnectionFlow && connectStep === 'folder' && (
						<div className='connection-flow'>
							<h3>
								{t('Choose a folder on {host}', { host: hostInput.trim() })}
							</h3>
							<label htmlFor='sftp-remote-dir'>{t('Folder:')}</label>
							<div className='sftp-path-row'>
								<input
									id='sftp-remote-dir'
									type='text'
									value={remoteDirInput}
									onChange={(e) => {
										setError(null);
										setRemoteDirInput(e.target.value);
									}}
									onKeyDown={(e) => {
										if (e.key === 'Enter') handleBrowse(remoteDirInput);
									}}
									disabled={isOperating}
								/>
								<button
									type='button'
									className='button secondary'
									onClick={() => handleBrowse(remoteDirInput)}
									disabled={isOperating || !remoteDirInput.trim()}
								>
									{t('Open')}
								</button>
							</div>
							{browse && (
								<div className='sftp-browser'>
									{browse.parent && (
										<button
											type='button'
											className='sftp-dir-item'
											onClick={() => handleBrowse(browse.parent as string)}
											disabled={isOperating}
										>
											<ChevronUpIcon /> ..
										</button>
									)}
									{browse.dirs.map((d) => (
										<button
											type='button'
											key={d.name}
											className='sftp-dir-item'
											onClick={() =>
												handleBrowse(joinRemote(browse.path, d.name))
											}
											disabled={isOperating}
											title={d.link ? t('Symbolic link') : undefined}
										>
											<FolderIcon /> {d.name}
											{d.link ? ' →' : ''}
										</button>
									))}
									{browse.dirs.length === 0 && (
										<div className='sftp-browser-empty'>
											{t('No subfolders')}
										</div>
									)}
								</div>
							)}
							{browse && (
								<p className='sftp-hint'>
									{t('{count} files in this folder', { count: browse.files })} ·{' '}
									<button
										type='button'
										className='sftp-link'
										onClick={() => handleBrowse('~')}
										disabled={isOperating}
									>
										{t('Home')}
									</button>
								</p>
							)}
							<div className='button-group'>
								<button
									type='button'
									className='button primary'
									onClick={handleUseFolder}
									disabled={isOperating || !remoteDirInput.trim()}
								>
									{t('Use this folder')}
								</button>
								<button
									type='button'
									className='button secondary'
									onClick={() => setConnectStep('server')}
									disabled={isOperating}
								>
									{t('Back')}
								</button>
							</div>
						</div>
					)}

					{projectId && !showConnectionFlow && (
						<div className='backup-status'>
							<div className='status-header'>
								<div className='backup-controls'>
									{!connected ? (
										<button
											className='button primary'
											onClick={handleOpenConnectionFlow}
											disabled={isOperating}
										>
											{t('Connect over SFTP')}
										</button>
									) : (
										<div className='backup-toolbar'>
											<div className='primary-actions'>
												<button
													className='button primary'
													onClick={() => handlePush(false)}
													disabled={isOperating || status.status === 'syncing'}
												>
													<GitPushIcon />
													{isOperating ? t('Pushing...') : t('Push via SFTP')}
												</button>
												<button
													className='button secondary'
													onClick={handleImport}
													disabled={isOperating || status.status === 'syncing'}
													title={t('Copy the server folder into this project')}
												>
													<ImportIcon />
													{t('Import from server')}
												</button>
												<button
													className='button warn secondary'
													onClick={() => handlePush(true)}
													disabled={isOperating || status.status === 'syncing'}
													title={t('Overwrite conflicting files on the server')}
												>
													{t('Force push')}
												</button>
											</div>
											<div className='secondary-actions'>
												<button
													type='button'
													className='button secondary'
													onClick={handleOpenConnectionFlow}
													disabled={isOperating}
													title={t('Connect to a different server or folder')}
												>
													<SftpIcon />
													{t('Change server')}
												</button>
												<button
													className='button secondary icon-only'
													onClick={handleDisconnect}
													disabled={isOperating}
													title={t('Disconnect')}
												>
													<DisconnectIcon />
												</button>
											</div>
										</div>
									)}
								</div>
							</div>
							<div className='status-info'>
								<div className='status-item'>
									<strong>{t('Project:')}</strong> {currentProjectName}
								</div>
								<div className='status-item'>
									<strong>{t('SFTP Backup:')}</strong>{' '}
									{connected ? t('Configured') : t('Not configured')}
								</div>
								{connected && (
									<div className='status-item'>
										<strong>{t('Target:')}</strong>{' '}
										<code>
											{status.host}:{status.remoteDir}
										</code>
									</div>
								)}
								{status.remoteHome && (
									<div className='status-item'>
										<strong>{t('Remote home:')}</strong>{' '}
										<code>{status.remoteHome}</code>
									</div>
								)}
								{status.lastSync && (
									<div className='status-item'>
										<strong>{t('Last Sync:')}</strong>{' '}
										{formatDate(status.lastSync)}
									</div>
								)}
							</div>
							{renderSummary()}
						</div>
					)}

					{activities.length > 0 && (
						<div className='backup-activities'>
							<div className='activities-header'>
								<h3>{t('Recent Activity')}</h3>
								<button
									className='button danger small secondary'
									onClick={() => sftpBackupService.clearAllActivities()}
									title={t('Clear all activities')}
									disabled={isOperating}
								>
									<TrashIcon />
									{t('Clear All')}
								</button>
							</div>
							<div className='activities-list'>
								{activities
									.slice(-10)
									.reverse()
									.map((activity) => (
										<div
											key={activity.id}
											className='activity-item'
											style={{
												borderLeftColor: getActivityColor(activity.type),
											}}
										>
											<div className='activity-content'>
												<div className='activity-header'>
													<span className='activity-message'>
														{activity.message}
													</span>
													<button
														aria-label={t('Dismiss activity')}
														className='activity-close'
														onClick={() =>
															sftpBackupService.clearActivity(activity.id)
														}
														title={t('Dismiss activity')}
														disabled={isOperating}
													>
														<span aria-hidden='true'>×</span>
													</button>
												</div>
												<div className='activity-time'>
													{formatDate(activity.timestamp)}
												</div>
											</div>
										</div>
									))}
							</div>
						</div>
					)}

					<div className='backup-info'>
						<h3>{t('How SFTP Backup Works')}</h3>
						<div className='info-content'>
							<ul>
								<li>
									{t(
										'Browsers cannot open SSH connections, so a local bridge (texlyre-sftp-bridge) holds the connection and uses your ~/.ssh/config, keys and known_hosts.',
									)}
								</li>
								<li>
									{t(
										'Push mirrors the plain project tree (main.tex, figures/, ...) into the remote directory, uploading only files that changed.',
									)}
								</li>
								<li>
									{t(
										'Files edited on the server, or not created by TeXlyre, are never overwritten unless you Force push. Build outputs next to the project are left alone.',
									)}
								</li>
								<li>
									{t(
										'Import from server copies an existing folder (e.g. a paper on your cluster) into this project once; later pushes only upload what you change.',
									)}
								</li>
							</ul>
						</div>
					</div>
				</div>
			</Modal>

			<SettingsModal
				isOpen={showSettings}
				onClose={() => setShowSettings(false)}
				initialCategory={t('Backup')}
				initialSubcategory={t('SFTP')}
			/>
		</>
	);
};

export default SftpBackupModal;
