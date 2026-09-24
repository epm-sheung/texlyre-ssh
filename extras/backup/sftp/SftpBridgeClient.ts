// extras/backup/sftp/SftpBridgeClient.ts
// Browser side of the texlyre-sftp-bridge WebSocket protocol:
// request {id, op, ...} -> response {id, ok, result | error}, plus
// server-initiated auth prompts (passphrases, MFA) and log events.
import { t } from '@/i18n';

export interface BridgePrompt {
	promptId: string;
	title: string;
	instructions: string;
	prompts: { prompt: string; echo: boolean }[];
}

export class BridgeRequestError extends Error {
	constructor(
		public code: string,
		message: string,
		public details?: any,
	) {
		super(message);
	}
}

const DEFAULT_TIMEOUT = 120_000;
// Connecting can wait on a human answering an MFA / passphrase prompt.
const CONNECT_TIMEOUT = 200_000;

export class SftpBridgeClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<
		number,
		{
			resolve: (value: any) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	onPrompt: (prompt: BridgePrompt) => Promise<string[] | null> = async () =>
		null;
	onLog: (level: string, message: string) => void = () => {};
	onClose: (code: number, reason: string) => void = () => {};

	get isOpen(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	async open(url: string, token: string): Promise<{ version: string }> {
		this.close();
		await new Promise<void>((resolve, reject) => {
			let ws: WebSocket;
			try {
				ws = new WebSocket(url);
			} catch {
				reject(
					new BridgeRequestError(
						'BAD_URL',
						t('Invalid bridge URL: {url}', { url }),
					),
				);
				return;
			}
			let opened = false;
			const unreachable = () =>
				new BridgeRequestError(
					'BRIDGE_UNREACHABLE',
					t(
						'Cannot reach the SFTP bridge at {url}. Start it with "node bridge.cjs" and try again.',
						{ url },
					),
				);
			const timer = setTimeout(() => {
				ws.close();
				reject(unreachable());
			}, 5000);
			ws.onopen = () => {
				opened = true;
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				if (opened) return;
				clearTimeout(timer);
				reject(unreachable());
			};
			ws.onclose = (event) => this.handleClose(ws, event);
			ws.onmessage = (event) => this.handleMessage(event.data);
			this.ws = ws;
		});
		return this.request('hello', { token });
	}

	request<T = any>(
		op: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(
				new BridgeRequestError(
					'BRIDGE_CLOSED',
					t('Not connected to the SFTP bridge'),
				),
			);
		}
		const id = this.nextId++;
		const timeoutMs = op === 'connect' ? CONNECT_TIMEOUT : DEFAULT_TIMEOUT;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new BridgeRequestError(
						'TIMEOUT',
						t('SFTP bridge did not answer "{op}" in time', { op }),
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ id, op, ...params }));
		});
	}

	close(): void {
		if (this.ws) {
			const ws = this.ws;
			this.ws = null;
			ws.close();
		}
	}

	private async handleMessage(raw: string): Promise<void> {
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}

		if (msg.event === 'log') {
			this.onLog(msg.level, msg.message);
			return;
		}
		if (msg.event === 'auth-prompt') {
			let responses: string[] | null = null;
			try {
				responses = await this.onPrompt(msg as BridgePrompt);
			} catch {
				responses = null;
			}
			this.ws?.send(
				JSON.stringify({
					op: 'auth-response',
					promptId: msg.promptId,
					responses,
				}),
			);
			return;
		}

		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);
		clearTimeout(pending.timer);
		if (msg.ok) {
			pending.resolve(msg.result);
		} else {
			pending.reject(
				new BridgeRequestError(
					msg.error?.code || 'UNKNOWN',
					msg.error?.message || t('SFTP bridge request failed'),
					msg.error?.details,
				),
			);
		}
	}

	private handleClose(ws: WebSocket, event: CloseEvent): void {
		if (this.ws === ws) this.ws = null;
		const reason =
			event.code === 4401
				? t(
						'The bridge rejected the token. Copy the token printed by the bridge into the SFTP settings.',
					)
				: event.reason || t('Connection to the SFTP bridge closed');
		for (const { reject, timer } of this.pending.values()) {
			clearTimeout(timer);
			reject(new BridgeRequestError('BRIDGE_CLOSED', reason));
		}
		this.pending.clear();
		this.onClose(event.code, reason);
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function sha256Hex(
	bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
}
