import {
    applySyncPlan,
    CONFLICT_DIR,
    type SyncApplyDeps,
    type SyncPlan,
} from '@extras/backup/sftp/syncApply';
import type { FileNode } from '@src/types/files';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytes = (s: string) => enc.encode(s) as Uint8Array<ArrayBuffer>;
const text = (c: FileNode['content']) =>
    typeof c === 'string' ? c : dec.decode(c as ArrayBuffer);

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const STAMP = '2026-09-24T12-00-00-000Z';

const emptyPlan = (patch: Partial<SyncPlan>): SyncPlan => ({
    planId: 'p1',
    upload: [],
    download: [],
    deleteRemote: [],
    deleteLocal: [],
    serverWins: [],
    ...patch,
});

const file = (path: string, content: string, documentId?: string): FileNode => ({
    id: `local:${path}`,
    name: path.split('/').pop() || '',
    path,
    type: 'file',
    content: bytes(content).buffer,
    lastModified: 1,
    documentId,
});

function setup(remote: Record<string, string>, docs: Record<string, string> = {}) {
    const stored: FileNode[] = [];
    const deleted: string[] = [];
    const puts: [string, string][] = [];
    const liveDocs = new Map(Object.entries(docs));
    let n = 0;
    const deps: SyncApplyDeps = {
        getRemote: async (rel) => ({
            bytes: bytes(remote[rel]),
            sha256: `sha-${rel}`,
            mtime: 1_000,
        }),
        putRemote: async (rel, b) => {
            puts.push([rel, dec.decode(b)]);
        },
        storeFiles: async (nodes) => {
            stored.push(...nodes);
        },
        deleteLocalFile: async (f) => {
            deleted.push(f.path);
        },
        updateDocument: async (id, updater) => {
            liveDocs.set(id, updater(liveDocs.get(id) ?? ''));
        },
        newId: () => `new${++n}`,
        mimeType: () => 'text/plain',
        isBinary: () => false,
        now: () => NOW,
    };
    return { deps, stored, deleted, puts, liveDocs };
}

describe('applySyncPlan', () => {
    it('downloads a new file and creates its folders', async () => {
        const { deps, stored } = setup({ 'sec/new.tex': 'from server' });
        const r = await applySyncPlan(
            emptyPlan({ download: ['sec/new.tex'] }),
            new Map(),
            new Map(),
            deps,
        );
        expect(stored.map((f) => [f.path, f.type])).toEqual([
            ['/sec', 'directory'],
            ['/sec/new.tex', 'file'],
        ]);
        expect(text(stored[1].content)).toBe('from server');
        expect(stored[1].lastModified).toBe(1_000_000);
        expect(r.downloaded).toEqual([{ path: '/sec/new.tex', sha256: 'sha-sec/new.tex' }]);
    });

    it('updates an unchanged linked document and keeps the file record', async () => {
        const local = file('/main.tex', 'v1', 'doc-main');
        const { deps, stored, liveDocs } = setup({ 'main.tex': 'v2 from server' }, { 'doc-main': 'v1' });
        const r = await applySyncPlan(
            emptyPlan({ download: ['main.tex'] }),
            new Map([['/main.tex', local]]),
            new Map([['main.tex', bytes('v1')]]),
            deps,
        );
        expect(liveDocs.get('doc-main')).toBe('v2 from server');
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe(local.id);
        expect(stored[0].documentId).toBe('doc-main');
        expect(text(stored[0].content)).toBe('v2 from server');
        expect(r.skipped).toEqual([]);
    });

    it('skips a document the user edited after the sync read it', async () => {
        const local = file('/main.tex', 'v1', 'doc-main');
        const { deps, stored, liveDocs } = setup(
            { 'main.tex': 'v2 from server' },
            { 'doc-main': 'v1 plus a sentence typed just now' },
        );
        const r = await applySyncPlan(
            emptyPlan({ download: ['main.tex'] }),
            new Map([['/main.tex', local]]),
            new Map([['main.tex', bytes('v1')]]),
            deps,
        );
        expect(liveDocs.get('doc-main')).toBe('v1 plus a sentence typed just now');
        expect(stored).toEqual([]);
        expect(r.skipped).toEqual(['main.tex']);
        expect(r.downloaded).toEqual([]);
    });

    it('server wins: backs up the live local text, then replaces it', async () => {
        const local = file('/chapter.tex', 'local edit', 'doc-ch');
        const { deps, stored, liveDocs } = setup(
            { 'chapter.tex': 'server edit' },
            { 'doc-ch': 'local edit, latest keystrokes' },
        );
        const r = await applySyncPlan(
            emptyPlan({
                serverWins: [{ path: 'chapter.tex', action: 'download', reason: 'changed-on-both' }],
            }),
            new Map([['/chapter.tex', local]]),
            new Map([['chapter.tex', bytes('local edit')]]),
            deps,
        );
        const backupPath = `${CONFLICT_DIR}/${STAMP}/chapter.tex`;
        expect(r.backups).toEqual([backupPath]);
        const backup = stored.find((f) => f.path === backupPath);
        expect(text(backup?.content)).toBe('local edit, latest keystrokes');
        expect(liveDocs.get('doc-ch')).toBe('server edit');
        expect(text(stored.find((f) => f.path === '/chapter.tex')?.content)).toBe('server edit');
    });

    it('deletes locally, keeping a backup when the server wins', async () => {
        const plain = file('/figs/a.png', 'png');
        const edited = file('/notes.tex', 'edited locally');
        const { deps, stored, deleted } = setup({});
        const r = await applySyncPlan(
            emptyPlan({
                deleteLocal: ['figs/a.png', 'already-gone.tex'],
                serverWins: [{ path: 'notes.tex', action: 'deleteLocal', reason: 'deleted-on-server' }],
            }),
            new Map([
                ['/figs/a.png', plain],
                ['/notes.tex', edited],
            ]),
            new Map(),
            deps,
        );
        expect(deleted).toEqual(['/figs/a.png', '/notes.tex']);
        expect(r.deletedLocal).toEqual(['/figs/a.png', '/already-gone.tex', '/notes.tex']);
        expect(r.backups).toEqual([`${CONFLICT_DIR}/${STAMP}/notes.tex`]);
        expect(stored.some((f) => f.path.endsWith('/notes.tex') && text(f.content) === 'edited locally')).toBe(true);
    });

    it('uploads the bytes collected for the plan', async () => {
        const { deps, puts } = setup({});
        await applySyncPlan(
            emptyPlan({ upload: ['main.tex'] }),
            new Map(),
            new Map([['main.tex', bytes('local v3')]]),
            deps,
        );
        expect(puts).toEqual([['main.tex', 'local v3']]);
    });
});
