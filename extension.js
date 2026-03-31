'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);
const WREC_CLASS_RE = /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+Wrec\b/;
const SUPPORTED_LANGUAGE_IDS = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact'
]);
const ISSUE_SECTIONS = new Set([
  'duplicate properties',
  'reserved property names',
  'invalid usedBy references',
  'invalid computed properties',
  'invalid values configurations',
  'invalid default values',
  'invalid form-assoc values',
  'missing formAssociated property',
  'missing type properties',
  'undefined properties',
  'undefined context functions',
  'undefined methods',
  'invalid event handler references',
  'invalid useState map entries',
  'incompatible arguments',
  'type errors',
  'unsupported html attributes',
  'unsupported event names'
]);

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection('wrec');
  const output = vscode.window.createOutputChannel('Wrec Lint');
  const runCounters = new Map();
  const missingDependencyWarnings = new Set();

  context.subscriptions.push(diagnostics, output);

  async function lintDocument(document, reason = 'manual') {
    if (!shouldProcessDocument(document)) {
      diagnostics.delete(document.uri);
      return;
    }

    const config = getConfig(document);
    if (!config.enabled) {
      diagnostics.delete(document.uri);
      return;
    }

    if (!definesWrecClass(document.getText())) {
      diagnostics.delete(document.uri);
      return;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      diagnostics.delete(document.uri);
      return;
    }

    const currentRun = (runCounters.get(document.uri.toString()) ?? 0) + 1;
    runCounters.set(document.uri.toString(), currentRun);

    const projectRoot = await findWrecProjectRoot(
      path.dirname(document.fileName),
      workspaceFolder.uri.fsPath
    );
    if (!projectRoot) {
      diagnostics.delete(document.uri);
      const warningKey = workspaceFolder.uri.fsPath;
      if (!missingDependencyWarnings.has(warningKey)) {
        missingDependencyWarnings.add(warningKey);
        vscode.window.showWarningMessage(
          'Wrec Lint On Save only runs in workspaces whose package.json declares a dependency on wrec.'
        );
      }
      return;
    }

    output.appendLine(`[${new Date().toISOString()}] Linting ${document.fileName} (${reason})`);

    try {
      const {stdout, stderr} = await execFileAsync(
        config.npxPath,
        ['wrec-lint', document.fileName],
        {
          cwd: projectRoot,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024
        }
      );

      if (isStaleRun(document, currentRun, runCounters)) return;

      if (stderr.trim()) {
        output.appendLine(stderr.trim());
      }

      const diagnosticsForFile = parseDiagnostics(stdout, document);
      diagnostics.set(document.uri, diagnosticsForFile);
      maybeShowOutput(output, config.showOutput, diagnosticsForFile.length > 0);

      if (stdout.trim()) {
        output.appendLine(stdout.trim());
      }
    } catch (error) {
      if (isStaleRun(document, currentRun, runCounters)) return;

      diagnostics.set(document.uri, [
        new vscode.Diagnostic(
          firstLineRange(document),
          errorMessageFrom(error),
          vscode.DiagnosticSeverity.Error
        )
      ]);

      output.appendLine(errorMessageFrom(error));
      maybeShowOutput(output, 'always', true);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => {
      void lintDocument(document, 'save');
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles(event => {
      for (const file of event.files) {
        diagnostics.delete(file);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('wrecLintOnSave.lintCurrentFile', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return;
      await lintDocument(document, 'command');
    })
  );
}

function deactivate() {}

function shouldProcessDocument(document) {
  return document.uri.scheme === 'file' && SUPPORTED_LANGUAGE_IDS.has(document.languageId);
}

function getConfig(document) {
  const config = vscode.workspace.getConfiguration('wrecLintOnSave', document.uri);
  return {
    enabled: config.get('enabled', true),
    npxPath: config.get('npxPath', 'npx'),
    showOutput: config.get('showOutput', 'onIssues')
  };
}

function definesWrecClass(text) {
  return WREC_CLASS_RE.test(text);
}

async function findWrecProjectRoot(startDirectory, workspaceRoot) {
  let currentDirectory = startDirectory;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);

  while (isWithinDirectory(currentDirectory, normalizedWorkspaceRoot)) {
    const packageJsonPath = path.join(currentDirectory, 'package.json');

    try {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      if (hasWrecDependency(packageJson)) {
        return currentDirectory;
      }
    } catch {
      // Ignore missing or invalid package.json files while walking upward.
    }

    if (currentDirectory === normalizedWorkspaceRoot) {
      break;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }
    currentDirectory = parentDirectory;
  }

  return null;
}

function hasWrecDependency(packageJson) {
  const dependencySections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies
  ];

  return dependencySections.some(section => Boolean(section && section.wrec));
}

function isWithinDirectory(candidatePath, parentPath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function parseDiagnostics(report, document) {
  if (!report || report.includes('no issues found')) return [];

  const diagnostics = [];
  const lines = report.split(/\r?\n/);
  let currentSection = '';

  for (const line of lines) {
    if (!line.trim()) continue;

    if (!line.startsWith('  ') && line.endsWith(':')) {
      currentSection = line.slice(0, -1);
      continue;
    }

    if (!ISSUE_SECTIONS.has(currentSection)) continue;
    if (!line.startsWith('  ')) continue;

    const message = `${startCase(currentSection)}: ${line.trim()}`;
    diagnostics.push(
      new vscode.Diagnostic(
        findBestRange(document, currentSection, line.trim()),
        message,
        diagnosticSeverity(currentSection)
      )
    );
  }

  return diagnostics;
}

function diagnosticSeverity(section) {
  if (
    section === 'undefined properties' ||
    section === 'undefined context functions' ||
    section === 'undefined methods' ||
    section === 'invalid event handler references' ||
    section === 'type errors'
  ) {
    return vscode.DiagnosticSeverity.Error;
  }

  return vscode.DiagnosticSeverity.Warning;
}

function findBestRange(document, section, detail) {
  const candidateTerms = new Set();
  const quotedMatches = detail.matchAll(/"([^"]+)"/g);
  for (const match of quotedMatches) {
    const term = match[1].trim();
    if (term) candidateTerms.add(term);
  }

  if (
    section === 'duplicate properties' ||
    section === 'reserved property names' ||
    section === 'undefined properties' ||
    section === 'undefined context functions' ||
    section === 'undefined methods'
  ) {
    candidateTerms.add(detail.trim());
  }

  for (const term of candidateTerms) {
    const range = findTermRange(document, term);
    if (range) return range;
  }

  return firstLineRange(document);
}

function findTermRange(document, term) {
  const escaped = escapeRegExp(term);
  const patterns = [
    new RegExp(`\\b${escaped}\\b`, 'g'),
    new RegExp(escaped, 'g')
  ];

  const text = document.getText();

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match || typeof match.index !== 'number') continue;

    const start = document.positionAt(match.index);
    const end = document.positionAt(match.index + match[0].length);
    return new vscode.Range(start, end);
  }

  return undefined;
}

function firstLineRange(document) {
  const firstLine = document.lineAt(0);
  return firstLine.range;
}

function maybeShowOutput(output, mode, hasIssues) {
  if (mode === 'always' || (mode === 'onIssues' && hasIssues)) {
    output.show(true);
  }
}

function isStaleRun(document, currentRun, runCounters) {
  return runCounters.get(document.uri.toString()) !== currentRun;
}

function errorMessageFrom(error) {
  if (error && typeof error === 'object') {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const message = error.message || '';
    return stderr || message || 'Wrec linter failed.';
  }

  return String(error);
}

function startCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  activate,
  deactivate
};
