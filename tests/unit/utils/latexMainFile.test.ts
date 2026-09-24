import { detectLatexMainFile } from '@src/utils/fileUtils';

describe('detectLatexMainFile', () => {
    const reader = (files: Record<string, string>) => async (path: string) =>
        files[path];

    it('prefers main.tex over the other .tex files', async () => {
        const files = {
            '/chapters/results.tex': '\\section{Results}',
            '/appendix.tex': '\\documentclass{article}',
            '/main.tex': '\\documentclass{article}',
        };
        await expect(
            detectLatexMainFile(Object.keys(files), reader(files)),
        ).resolves.toBe('/main.tex');
    });

    it('picks the shallowest main.tex', async () => {
        const paths = ['/old/main.tex', '/main.tex', '/a/b/main.tex'];
        await expect(detectLatexMainFile(paths, reader({}))).resolves.toBe(
            '/main.tex',
        );
    });

    it('matches main.tex case-insensitively', async () => {
        await expect(
            detectLatexMainFile(['/chapters/intro.tex', '/Main.TeX'], reader({})),
        ).resolves.toBe('/Main.TeX');
    });

    it('falls back to the file with \\documentclass when there is no main.tex', async () => {
        const files = {
            '/sections/intro.tex': 'Intro text',
            '/paper.tex': '% comment\n\\documentclass[10pt]{article}\n',
        };
        await expect(
            detectLatexMainFile(Object.keys(files), reader(files)),
        ).resolves.toBe('/paper.tex');
    });

    it('ignores a commented-out \\documentclass', async () => {
        const files = {
            '/a.tex': '% \\documentclass{article}\nbody',
            '/b/real.tex': '\\documentclass{article}',
        };
        await expect(
            detectLatexMainFile(Object.keys(files), reader(files)),
        ).resolves.toBe('/b/real.tex');
    });

    it('returns undefined when nothing looks like a main document', async () => {
        const files = {
            '/chapters/a.tex': '\\section{A}',
            '/chapters/b.tex': 'text',
        };
        await expect(
            detectLatexMainFile(Object.keys(files), reader(files)),
        ).resolves.toBeUndefined();
    });

    it('skips files that fail to read', async () => {
        const read = async (path: string) => {
            if (path === '/broken.tex') throw new Error('read failed');
            return path === '/doc.tex' ? '\\documentclass{article}' : '';
        };
        await expect(
            detectLatexMainFile(['/broken.tex', '/doc.tex'], read),
        ).resolves.toBe('/doc.tex');
    });
});
