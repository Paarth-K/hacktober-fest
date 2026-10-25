import { ContextPacketSchema, type ContextPacket, type EvidenceRef } from './contracts.js';

const SENSITIVE = /(^|\/)(\.git|node_modules|dist|build|target|\.env(?:\..*)?|\.ssh|\.aws|secrets?|credentials?)(\/|$)|(?:^|\/)(?:id_rsa|id_ed25519|.*\.(?:pem|key|p12|pfx|sqlite|db|png|jpg|zip|exe|wasm))$/i;
export function isSafeContextPath(path: string): boolean {
  return !(!path || path.startsWith('/') || path.includes('\\') || path.includes(':') || /[\x00-\x1f]/.test(path) || path.split('/').some(p => p === '..' || p === '.' || !p) || SENSITIVE.test(path));
}
const SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i;
export function boundContext(input: unknown, maxBytes = 24000): ContextPacket {
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 100000) throw new Error('Invalid context budget');
  const packet = ContextPacketSchema.parse(input);
  const result: ContextPacket = { excerpts: [], omissions: [], verificationRuns: [] };
  let used = 0;
  for (const excerpt of packet.excerpts) {
    if (!isSafeContextPath(excerpt.evidence.path) || SECRET_TEXT.test(excerpt.text)) {
      result.omissions.push('Excluded an unsafe path or potentially secret-bearing excerpt.');
      continue;
    }
    // Keep complete evidence spans only, avoiding citations to truncated text.
    const size = Buffer.byteLength(JSON.stringify(excerpt), 'utf8');
    if (used + size > maxBytes) { result.omissions.push('Excluded an excerpt to keep the context within its byte budget.'); continue; }
    used += size;
    result.excerpts.push(excerpt);
  }
  // Omission details and command text are untrusted too; do not echo secrets.
  result.omissions.push(...packet.omissions.filter(x => !SECRET_TEXT.test(x)).slice(0, 20).map(x => x.slice(0, 300)));
  result.omissions = result.omissions.slice(0, 30);
  result.verificationRuns = packet.verificationRuns.filter(run => !SECRET_TEXT.test(run.command)).slice(0, 10).map(run => ({ ...run, command: run.command.slice(0, 1000) }));
  return result;
}
export function validateCitations(refs: EvidenceRef[], packet: ContextPacket): void {
  for (const ref of refs) {
    const allowed = packet.excerpts.some(({ evidence: known }) =>
      ref.id === known.id && ref.path === known.path && ref.changeBatchId === known.changeBatchId &&
      ref.startLine >= known.startLine && ref.endLine <= known.endLine);
    if (!allowed) throw new Error('Model returned an unsupported file/line citation');
  }
}

export function assertNoSecrets(input: unknown): void {
  if (SECRET_TEXT.test(JSON.stringify(input))) throw new Error('Input may contain a secret; remove it before requesting model inference');
}
/** Additional prose checks catch explicit fictional paths outside the citation array. */
export function validateProseReferences(prose: string, packet: ContextPacket): void {
  const mentions = prose.matchAll(/(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_-]+\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|java|json|md|txt|html|css|ya?ml|toml)(?![A-Za-z0-9_])(?::(\d+)(?:[-–](\d+))?)?/g);
  for (const match of mentions) {
    const token = match[0]!;
    const path = token.split(':')[0]!;
    // A dotted identifier followed by '(' is a call expression, not a file
    // citation (express.json(), res.json(), response.json ()). Explicit paths
    // and line references still require grounding, even before parentheses.
    if (!path.includes('/') && !match[1] && /^\s*\(/.test(prose.slice(match.index! + token.length))) continue;
    let known = packet.excerpts.filter(e => e.evidence.path === path).map(e => e.evidence);
    if (!known.length && !path.includes('/')) {
      const matches = packet.excerpts.filter(e => e.evidence.path.split('/').at(-1) === path).map(e => e.evidence);
      if (new Set(matches.map(e => e.path)).size === 1) known = matches;
    }
    if (!known.length) throw new Error('Unsupported path in model prose');
    if (match[1]) {
      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (end < start || !known.some(e => start >= e.startLine && end <= e.endLine)) throw new Error('Unsupported line range in model prose');
    }
  }
}
