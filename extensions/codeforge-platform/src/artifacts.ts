import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface BuildArtifact {
  filePath: string;
  relativePath: string;
  fileName: string;
  size: number;
  modifiedAt: number;
  kind: string;
}

const defaultArtifactDirectories = [
  'dist',
  'release',
  'releases',
  'out',
  'build',
  'target/release',
  'app/build/outputs',
  'android/app/build/outputs'
];

const artifactExtensions = new Map<string, string>([
  ['.exe', 'Windows executable'],
  ['.msi', 'Windows installer'],
  ['.msix', 'Windows MSIX'],
  ['.appx', 'Windows AppX'],
  ['.zip', 'ZIP archive'],
  ['.appimage', 'Linux AppImage'],
  ['.deb', 'Debian package'],
  ['.rpm', 'RPM package'],
  ['.dmg', 'macOS disk image'],
  ['.pkg', 'macOS installer'],
  ['.apk', 'Android APK'],
  ['.aab', 'Android App Bundle'],
  ['.ipa', 'Apple IPA'],
  ['.gz', 'Compressed archive'],
  ['.tgz', 'Compressed archive']
]);

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  '.gradle',
  '.dart_tool',
  '.idea',
  '.vscode',
  'cache',
  'caches',
  'logs'
]);

function artifactKind(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tar.gz archive';
  return artifactExtensions.get(path.extname(lower));
}

function configuredRoots(): string[] {
  const configured = vscode.workspace.getConfiguration('codeforge.build').get<string[]>('artifactDirectories', defaultArtifactDirectories);
  return [...new Set(configured.map(value => value.trim()).filter(Boolean))];
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function scanDirectory(
  directory: string,
  workspaceRoot: string,
  minModifiedAt: number,
  maxDepth: number,
  currentDepth: number,
  results: BuildArtifact[],
  seen: Set<string>
): Promise<void> {
  if (currentDepth > maxDepth || results.length >= 250) return;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async entry => {
    if (results.length >= 250) return;
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name.toLowerCase())) {
        await scanDirectory(fullPath, workspaceRoot, minModifiedAt, maxDepth, currentDepth + 1, results, seen);
      }
      return;
    }

    if (!entry.isFile()) return;
    const kind = artifactKind(entry.name);
    if (!kind) return;

    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      return;
    }
    if (stat.mtimeMs < minModifiedAt) return;

    const normalized = path.resolve(fullPath);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push({
      filePath: normalized,
      relativePath: path.relative(workspaceRoot, normalized),
      fileName: path.basename(normalized),
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      kind
    });
  }));
}

async function scanRootFiles(workspaceRoot: string, minModifiedAt: number, results: BuildArtifact[], seen: Set<string>): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const kind = artifactKind(entry.name);
    if (!kind) continue;
    const fullPath = path.join(workspaceRoot, entry.name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < minModifiedAt) continue;
    const normalized = path.resolve(fullPath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({
      filePath: normalized,
      relativePath: entry.name,
      fileName: entry.name,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      kind
    });
  }
}

export async function findFreshBuildArtifacts(workspaceRoot: string, buildStartedAt: number): Promise<BuildArtifact[]> {
  const results: BuildArtifact[] = [];
  const seen = new Set<string>();
  const minModifiedAt = buildStartedAt - 5000;
  const maxDepth = Math.max(1, Math.min(8, vscode.workspace.getConfiguration('codeforge.build').get<number>('artifactScanDepth', 5)));

  await scanRootFiles(workspaceRoot, minModifiedAt, results, seen);

  for (const relativeRoot of configuredRoots()) {
    const directory = path.resolve(workspaceRoot, relativeRoot);
    if (!directory.startsWith(path.resolve(workspaceRoot))) continue;
    if (!(await pathExists(directory))) continue;
    await scanDirectory(directory, workspaceRoot, minModifiedAt, maxDepth, 0, results, seen);
  }

  return results
    .filter(artifact => artifact.size > 0 && artifact.size <= 2 * 1024 * 1024 * 1024)
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.relativePath.localeCompare(b.relativePath));
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}
