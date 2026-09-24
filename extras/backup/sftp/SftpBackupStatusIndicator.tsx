// extras/backup/sftp/SftpBackupStatusIndicator.tsx
import { t } from '@/i18n';
import React, { useState } from 'react';
import SftpBackupModal from './SftpBackupModal';
import { sftpBackupService } from './SftpBackupService';
import './styles.css';

interface SftpBackupStatusIndicatorProps {
	className?: string;
	currentProjectId?: string | null;
	isInEditor?: boolean;
}

const SftpBackupStatusIndicator: React.FC<SftpBackupStatusIndicatorProps> = ({
	className = '',
	currentProjectId,
	isInEditor = false,
}) => {
	const [status, setStatus] = useState(sftpBackupService.getStatus());
	const [activities, setActivities] = useState(
		sftpBackupService.getActivities(),
	);
	const [showModal, setShowModal] = useState(false);

	React.useEffect(() => {
		const unsubscribeStatus = sftpBackupService.addStatusListener(setStatus);
		const unsubscribeActivities =
			sftpBackupService.addActivityListener(setActivities);
		return () => {
			unsubscribeStatus();
			unsubscribeActivities();
		};
	}, []);

	const getStatusColor = () => {
		if (!status.isConnected) return '#666';
		if (status.status === 'error') return '#dc3545';
		if (status.status === 'syncing') return '#ffc107';
		return '#28a745';
	};

	const getStatusText = () => {
		if (!status.isConnected) return t('SFTP not connected');
		if (status.status === 'error') return t('SFTP error');
		if (status.status === 'syncing') return t('Syncing...');
		if (status.lastSync) {
			return t('Last Sync: {time}', {
				time: new Date(status.lastSync).toLocaleTimeString(),
			});
		}
		return t('SFTP target: {host}:{dir}', {
			host: status.host,
			dir: status.remoteDir,
		});
	};

	return (
		<>
			<div
				className={`backup-status-indicator main-button single-service ${className} ${status.isConnected ? 'connected' : 'disconnected'}`}
				onClick={() => setShowModal(true)}
				title={getStatusText()}
			>
				<div
					className='status-dot'
					style={{ backgroundColor: getStatusColor() }}
				/>
				<span className='backup-label'>{t('SFTP')}</span>
				{activities.length > 0 && <div className='activity-notification' />}
			</div>

			<SftpBackupModal
				isOpen={showModal}
				onClose={() => setShowModal(false)}
				currentProjectId={currentProjectId}
				isInEditor={isInEditor}
			/>
		</>
	);
};

export default SftpBackupStatusIndicator;
