// extras/backup/sftp/settings.ts
import { t } from '@/i18n';
import type { Setting } from '@/contexts/SettingsContext';

export const SFTP_DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:7050';

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
			'Token printed by the bridge on startup. It only unlocks the local bridge; SSH keys never leave your machine.',
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
		defaultValue:
			'build,.git,*.aux,*.log,*.out,*.fls,*.fdb_latexmk,*.synctex.gz,*.blg,*.toc',
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
