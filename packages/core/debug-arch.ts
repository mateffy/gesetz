// Test the regex directly
const content = "import { secret } from '../b/secret';";

const staticImport = /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
const results: string[] = [];
let match: RegExpExecArray | null;
while ((match = staticImport.exec(content)) !== null) {
  results.push(match[1]);
}
console.log('extracted imports:', results);

// Test path resolution
const fileDir = 'src/a';
const importPath = '../b/secret';
const importedPath = importPath.startsWith('.') ? `${fileDir}/${importPath}` : importPath;
console.log('importedPath:', importedPath);

// Test target matching
const fileToLayer = new Map([['src/a/index.ts', 'a'], ['src/b/secret.ts', 'b']]);
for (const [targetPath, targetLayer] of fileToLayer.entries()) {
  const normalizedTarget = targetPath.replace(/\.(ts|tsx|js|jsx)$/, '');
  const check1 = normalizedTarget.endsWith(importedPath.replace(/\.\//g, '/'));
  const check2 = normalizedTarget === importedPath;
  console.log('target:', targetPath, 'normalized:', normalizedTarget, 'check1:', check1, 'check2:', check2);
}
