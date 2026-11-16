// EMBERLINE — main.ts
// The entrypoint for the threejs-fps-01 bounty. It hands the game in: it
// copies game/ and screenshots/ from this repository into the output
// directory and writes dossier.json with buildDossier from the kit's
// vendor/makefun-threejs.ts. Standard library only, no network, and fully
// deterministic: the same repository always produces the same bytes.
//
// Run locally:  MAKEFUN_OUTPUT_DIR=out node main.ts
// In the grader: /output is used (MAKEFUN_OUTPUT_DIR unset).

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

// The gate's caps, exactly as RULES.txt states them: the dossier text is
// capped at 160 KiB, at most 4 screenshots of 256 KiB each, game/ at most
// 993 entries and 48 MiB, and every game path at most 1000 bytes.
const CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 48 * 1024 * 1024,
  game_path_max_bytes: 1000,
} as const;

const repoRoot = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

function copyTree(srcDir: string, dstDir: string): number {
  // Copy regular files only, in sorted order, skipping nothing the entry
  // ships (screenshots and game files alike). Symlinks are refused rather
  // than followed: the gate rejects them.
  mkdirSync(dstDir, { recursive: true });
  let files = 0;
  for (const name of readdirSync(srcDir).sort()) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const st = statSync(src);
    if (st.isSymbolicLink()) throw new Error(`refusing symlink in entry: ${src}`);
    if (st.isDirectory()) files += copyTree(src, dst);
    else if (st.isFile()) {
      cpSync(src, dst);
      files += 1;
    }
  }
  return files;
}

function main(): void {
  const gameDir = join(repoRoot, 'game');
  const shotsDir = join(repoRoot, 'screenshots');
  if (!existsSync(gameDir)) throw new Error(`game/ missing in ${repoRoot}`);
  if (!existsSync(shotsDir)) throw new Error(`screenshots/ missing in ${repoRoot}`);
  mkdirSync(outDir, { recursive: true });
  const gameFiles = copyTree(gameDir, join(outDir, 'game'));
  const shotFiles = copyTree(shotsDir, join(outDir, 'screenshots'));
  const dossier = buildDossier(outDir, CAPS);
  writeFileSync(join(outDir, 'dossier.json'), dossier);
  // The gate refuses a dossier over 1.5 MiB, so fail loudly here instead of
  // handing in an entry the scorer would reject.
  if (dossier.length > 1536 * 1024) {
    throw new Error(`dossier.json is ${dossier.length} bytes, over the 1.5 MiB gate cap`);
  }
  console.log(
    `EMBERLINE: wrote ${gameFiles} game files + ${shotFiles} screenshots to ${outDir} ` +
    `(dossier.json ${dossier.length} bytes)`,
  );
}

main();
