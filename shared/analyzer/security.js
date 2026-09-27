// A built-in vulnerability & code-quality rule engine — a Semgrep-lite that
// runs entirely locally, no external binary. Rules are regex/line based,
// language-scoped, each with a severity and a category. Per-file findings are
// attached during the scan; summarizeSecurity rolls them into a repo grade.

import { lineCounter } from './util.js';

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];
export const sevRank = (s) => SEVERITIES.indexOf(s);

// Each rule: id, severity, category, message, rx. `byLine` rules test each
// line (and report the line number); others test the whole source once.
const RULES = [
  { id: 'hardcoded-secret', severity: 'critical', category: 'secret',
    message: 'Hardcoded credential — move it to env/config.',
    rx: /\b(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i, byLine: true },
  { id: 'aws-key', severity: 'critical', category: 'secret',
    message: 'Looks like an AWS access key id.',
    rx: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, byLine: true },
  { id: 'private-key-block', severity: 'critical', category: 'secret',
    message: 'A private key is committed to the source.',
    rx: /-----BEGIN (RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/ },
  { id: 'eval', severity: 'high', category: 'injection', langs: ['javascript'],
    message: 'eval() executes strings as code — classic injection sink.',
    rx: /\beval\s*\(/, byLine: true },
  { id: 'new-function', severity: 'high', category: 'injection', langs: ['javascript'],
    message: 'new Function() is eval in a trench coat.',
    rx: /\bnew Function\s*\(/, byLine: true },
  { id: 'child-exec', severity: 'high', category: 'injection', langs: ['javascript'],
    message: 'Shelling out — if any argument is user input, this is command injection.',
    rx: /\b(child_process\.(exec|spawn)|execSync|spawnSync)\s*\(/, byLine: true },
  { id: 'os-system', severity: 'high', category: 'injection', langs: ['python'],
    message: 'os.system / shell=True runs a shell — sanitize any input reaching it.',
    rx: /\bos\.system\s*\(|shell\s*=\s*True/, byLine: true },
  { id: 'sql-concat', severity: 'high', category: 'injection',
    message: 'SQL built by string concatenation/formatting — use parameterized queries.',
    rx: /\b(execute|query|exec|raw)\s*\(\s*[^)]*(\+|\$\{|\.format\(|f["'])/, byLine: true },
  { id: 'innerhtml', severity: 'medium', category: 'xss', langs: ['javascript'],
    message: 'Writing raw HTML — if the value is user-controlled, this is XSS.',
    rx: /\b(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML|document\.write\s*\(/, byLine: true,
    ignore: /\b(innerHTML|outerHTML)\s*=\s*(['"`])\2\s*;?\s*$/ },
  { id: 'weak-hash', severity: 'medium', category: 'crypto',
    message: 'MD5/SHA-1 are broken — use SHA-256+, and bcrypt/argon2 for passwords.',
    rx: /\b(md5|sha1)\s*\(|createHash\(\s*['"](md5|sha1)['"]/, byLine: true },
  { id: 'math-random', severity: 'low', category: 'crypto', langs: ['javascript'],
    message: 'Math.random() is not cryptographically secure.',
    rx: /\bMath\.random\s*\(/, byLine: true },
  { id: 'insecure-deser', severity: 'high', category: 'deserialization',
    message: 'Insecure deserialization — untrusted data here is remote code execution.',
    rx: /\b(pickle\.loads?|yaml\.load\s*\((?![^)]*SafeLoader)|unserialize\s*\(|ObjectInputStream)/, byLine: true },
  { id: 'open-redirect', severity: 'medium', category: 'redirect',
    message: 'Redirect target comes from the request — open-redirect risk.',
    rx: /\b(res\.redirect|redirect)\s*\(\s*(req\.|request\.)/, byLine: true },
  { id: 'localhost-url', severity: 'low', category: 'config',
    message: 'Hardcoded localhost/127.0.0.1 — will break outside this machine.',
    rx: /['"`](https?:\/\/(localhost|127\.0\.0\.1)|localhost:\d|127\.0\.0\.1)/, byLine: true },
  { id: 'debugger', severity: 'low', category: 'debug', langs: ['javascript'],
    message: 'A debugger statement is left in.',
    rx: /\bdebugger\s*;?/, byLine: true },
  { id: 'console-log', severity: 'info', category: 'debug', langs: ['javascript'],
    message: 'console.log — fine locally, noise in production.',
    rx: /\bconsole\.(log|debug|info)\s*\(/, byLine: true },
  { id: 'print-stmt', severity: 'info', category: 'debug', langs: ['python'],
    message: 'print() — use the logger in production code.',
    rx: /^\s*print\s*\(/, byLine: true },
  { id: 'todo', severity: 'info', category: 'quality',
    message: 'TODO/FIXME left in the source.',
    rx: /\b(TODO|FIXME|XXX|HACK)\b/, byLine: true },
  { id: 'loose-eq', severity: 'low', category: 'quality', langs: ['javascript'],
    message: 'Loose equality (==) coerces types — prefer ===.',
    rx: /[^=!<>]==[^=]/, byLine: true },
  { id: 'var-keyword', severity: 'low', category: 'quality', langs: ['javascript'],
    message: 'var is function-scoped and hoisted — prefer let/const.',
    rx: /\bvar\s+[A-Za-z_$]/, byLine: true },
  { id: 'empty-catch', severity: 'medium', category: 'quality',
    message: 'Swallowed exception — errors vanish silently here.',
    rx: /(catch\s*\([^)]*\)\s*\{\s*\}|except\s*\w*\s*:\s*pass\b)/, byLine: true },
  // JSON Web Tokens start with a base64-encoded header that is always
  // `eyJ…` ("{"). A line that contains one and treats it as a literal
  // string — rather than reading it from a vault — is the same shape of
  // mistake as a hardcoded API key. Three base64 segments separated by
  // dots is the JWT signature; we only require the first segment to keep
  // the rule cheap.
  { id: 'jwt-secret', severity: 'critical', category: 'secret',
    message: 'Looks like a hardcoded JWT — treat it like a credential, not a string.',
    rx: /['"`](eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})['"`]/, byLine: true },
  // The `os-system` rule already catches `os.system` and `shell=True` on
  // subprocess calls, but `subprocess.Popen(..., shell=True)` and
  // `subprocess.run(..., shell=True)` are the modern Python way to do
  // the same thing, and a regex on `shell=True` alone matches both
  // without the false-positive rate. A separate rule for Popen keeps the
  // message specific and the langs filter honest.
  { id: 'subprocess-shell', severity: 'high', category: 'injection', langs: ['python'],
    message: 'subprocess.* with shell=True runs a shell — sanitize any input reaching it.',
    rx: /\bsubprocess\.(Popen|run|call|check_output|check_call)\s*\([^)]*shell\s*=\s*True/, byLine: true },
  // Go's `http.ListenAndServe` defaults to binding all interfaces when
  // given a `":port"` address (the colon makes it a wildcard), and a
  // literal `0.0.0.0` does the same. That is fine inside a container with
  // a tight network policy and a bug everywhere else: the dev box, the
  // staging cluster, the CI runner, the laptop on coffee-shop Wi-Fi. The
  // rule does not distinguish "0.0.0.0" from "127.0.0.1" because the
  // safer pattern is always `127.0.0.1:<port>`, so the finding is a
  // nudge rather than an alarm.
  { id: 'go-public-listen', severity: 'medium', category: 'config', langs: ['go'],
    message: 'Go listener binds all interfaces (":port" or "0.0.0.0") — bind 127.0.0.1 explicitly.',
    rx: /(ListenAndServe|Listen|TLS\s*\.\s*Listen|ListenAndServeTLS)\s*\(\s*["'](:[0-9]+|0\.0\.0\.0(?::[0-9]+)?|::)["']/, byLine: true },
];

// Findings for one file, run at scan time while the source is in hand.
export function analyzeSecurityFile(source, lang) {
  const findings = [];
  const text = String(source);
  const lines = text.split('\n');
  // Whole-file rules report a byte offset and need it as a line number. Built
  // once and lazily: most files trip none of these rules and never build it.
  const lineAt = lineCounter(text);
  for (const rule of RULES) {
    if (rule.langs && !rule.langs.includes(lang)) continue;
    if (rule.byLine) {
      for (let i = 0; i < lines.length; i++) {
        if (rule.ignore && rule.ignore.test(lines[i])) continue;
        const m = lines[i].match(rule.rx);
        if (m) {
          findings.push({ rule: rule.id, severity: rule.severity, category: rule.category, message: rule.message, line: i + 1, excerpt: lines[i].trim().slice(0, 90) });
        }
      }
    } else {
      const m = text.match(rule.rx);
      if (m) {
        findings.push({ rule: rule.id, severity: rule.severity, category: rule.category, message: rule.message, line: lineAt(m.index), excerpt: (m[0] || '').slice(0, 90) });
      }
    }
  }
  return findings;
}

// Repo-level roll-up: counts by severity and category, the files carrying
// findings (worst-first), and a 0–100 score + grade.
export function summarizeSecurity(scan) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCat = {};
  const files = [];
  for (const f of scan.files) {
    const finds = f.findings || [];
    if (!finds.length) continue;
    let worst = 'info';
    for (const x of finds) {
      counts[x.severity]++;
      byCat[x.category] = (byCat[x.category] || 0) + 1;
      if (sevRank(x.severity) > sevRank(worst)) worst = x.severity;
    }
    files.push({ path: f.path, name: f.name, findings: finds, worst, count: finds.length });
  }
  files.sort((a, b) => sevRank(b.worst) - sevRank(a.worst) || b.count - a.count);

  let score = 100;
  score -= counts.critical * 15;
  score -= counts.high * 6;
  score -= counts.medium * 2;
  score -= Math.min(10, counts.low);
  score = Math.max(0, Math.round(score));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';

  return { counts, byCat, files, score, grade, total: files.reduce((s, f) => s + f.count, 0) };
}

// Fold an external engine's findings into the scan, in place, so the security
// view — which reads `scan.files[].findings` and re-summarizes — sees one list.
// Dedup is on (path, line, rule): two engines flagging the same line for the
// same reason are one problem. This is the shared, pure half of the merge; the
// fetching and spawning live on the server.
export function mergeFindingsIntoScan(scan, external) {
  if (!scan || !Array.isArray(external) || !external.length) return 0;
  const byPath = new Map(scan.files.map((f) => [f.path, f]));
  let added = 0;
  for (const finding of external) {
    const file = byPath.get(finding.path);
    if (!file) continue; // a path the scanner never accepted is not ours to show
    const list = file.findings || (file.findings = []);
    const dupe = list.some((x) => x.line === finding.line && x.rule === finding.rule);
    if (dupe) continue;
    list.push(finding);
    added++;
  }
  return added;
}

