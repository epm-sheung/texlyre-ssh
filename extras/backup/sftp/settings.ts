// extras/backup/sftp/settings.ts
import { t } from '@/i18n';
import type { Setting } from '@/contexts/SettingsContext';

export const SFTP_DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:7050';
export const SFTP_DEFAULT_IMPORT_EXCLUDE =
	'build,.git,*.aux,*.log,*.out,*.fls,*.fdb_latexmk,*.synctex.gz,*.blg,*.toc';
export const SFTP_DEFAULT_AUTO_SYNC_SECONDS = 60;

export const getSftpBackupSettings = (): Setting[] => [
	{
		id: 'sftp-backup-bridge-url',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'text',
		label: t('Bridge URL'),
		description: t(
			'WebSocket address of the local SFTP bridge (texlyre-sftp-bridge)',
		),
		defaultValue: SFTP_DEFAULT_BRIDGE_URL,
	},
	{
		id: 'sftp-backup-bridge-token',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'text',
		label: t('Bridge token'),
		description: t(
			'Filled in automatically when TeXlyre is opened with the Start TeXlyre launcher. Otherwise paste the token shown in the bridge window. It only unlocks the local bridge; SSH keys never leave your machine.',
		),
		defaultValue: '',
	},
	{
		id: 'sftp-backup-ignore-patterns',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'text',
		label: t('Ignore patterns'),
		description: t(
			'Comma-separated list of file patterns to exclude from backup (e.g., *.log,*.tmp)',
		),
		defaultValue: '*.log,*.tmp',
	},
	{
		id: 'sftp-backup-import-exclude',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'text',
		label: t('Import exclude patterns'),
		description: t(
			'Comma-separated patterns skipped when importing from the server. Names without "/" match anywhere (e.g., build prunes every build folder); "*" does not cross "/".',
		),
		defaultValue: SFTP_DEFAULT_IMPORT_EXCLUDE,
	},
	{
		id: 'sftp-backup-auto-sync',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'checkbox',
		label: t('Auto-sync'),
		description: t(
			'Keep the open project in sync with the server in the background (after you log in once per session). The server version wins when a file changed on both sides; your version is saved under .texlyre/sftp-conflicts/.',
		),
		defaultValue: true,
	},
	{
		id: 'sftp-backup-auto-sync-interval',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'number',
		label: t('Auto-sync interval (seconds)'),
		description: t('How often to sync in the background (minimum 15)'),
		defaultValue: SFTP_DEFAULT_AUTO_SYNC_SECONDS,
		min: 15,
	},
	{
		id: 'sftp-backup-max-file-size',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'number',
		label: t('Max file size (MB)'),
		description: t('Skip files larger than this size'),
		defaultValue: 100,
	},
	{
		id: 'sftp-backup-activity-history-limit',
		category: t('Backup'),
		subcategory: t('SFTP'),
		type: 'number',
		label: t('Activity history limit'),
		description: t('Maximum number of activities to keep in history'),
		defaultValue: 50,
	},
];
