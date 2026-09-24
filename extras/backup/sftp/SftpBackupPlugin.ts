// extras/backup/sftp/SftpBackupPlugin.ts
import type { BackupPlugin } from '@/plugins/PluginInterface';
import SftpBackupModal from './SftpBackupModal';
import { sftpBackupService } from './SftpBackupService';
import SftpBackupStatusIndicator from './SftpBackupStatusIndicator';
import { SftpIcon } from './Icon';
import { getSftpBackupSettings } from './settings';

const sftpBackupPlugin: BackupPlugin = {
	id: 'sftp-backup',
	name: 'SFTP',
	version: '0.1.0',
	type: 'backup',
	icon: SftpIcon,
	get settings() {
		return getSftpBackupSettings();
	},

	canHandle: (backupType: string): boolean => {
		return backupType === 'sftp';
	},

	renderStatusIndicator: SftpBackupStatusIndicator,
	renderModal: SftpBackupModal,
	getService: () => sftpBackupService,
};

export default sftpBackupPlugin;
