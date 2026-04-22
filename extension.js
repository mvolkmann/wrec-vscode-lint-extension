"use strict";

const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const WREC_CLASS_RE = /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+Wrec\b/;
const WREC_DECLARE_MISSING_MESSAGE = missingCliMessage("declare");
const WREC_LINT_MISSING_MESSAGE = missingCliMessage("lint");
const WREC_SCAFFOLD_MISSING_MESSAGE = missingCliMessage("scaffold");
const WREC_USED_BY_MISSING_MESSAGE = missingCliMessage("used-by");
const SUPPORTED_LANGUAGE_IDS = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);
// Activates the extension and registers commands, listeners, and UI elements.
function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection("wrec");
  const output = vscode.window.createOutputChannel("Wrec Lint");
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  const runCounters = new Map();
  const missingDependencyWarnings = new Set();
  const projectRootCache = new Map();
  let activeLintRuns = 0;

  statusBarItem.name = "Wrec Lint";
  statusBarItem.show();
  updateStatusBar(statusBarItem, "idle");

  context.subscriptions.push(diagnostics, output, statusBarItem);

  // Lints a document, updates diagnostics, and
  // logs results to the output channel.
  async function lintDocument(document, reason = "manual") {
    if (!shouldProcessDocument(document)) {
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

    activeLintRuns += 1;
    updateStatusBar(statusBarItem, "running", document.fileName);

    const projectRoot = await findWrecProjectRoot(
      path.dirname(document.fileName),
      workspaceFolder.uri.fsPath,
      projectRootCache,
    );
    if (!projectRoot) {
      diagnostics.delete(document.uri);
      activeLintRuns = Math.max(0, activeLintRuns - 1);
      if (activeLintRuns === 0) {
        updateStatusBar(statusBarItem, "idle");
      }
      const warningKey = workspaceFolder.uri.fsPath;
      if (!missingDependencyWarnings.has(warningKey)) {
        missingDependencyWarnings.add(warningKey);
        vscode.window.showWarningMessage(
          "Wrec Lint On Save only runs in workspaces whose package.json declares a dependency on wrec.",
        );
      }
      return;
    }

    if (!definesWrecClass(document.getText())) {
      diagnostics.delete(document.uri);
      activeLintRuns = Math.max(0, activeLintRuns - 1);
      if (activeLintRuns === 0) {
        updateStatusBar(statusBarItem, "idle");
      }
      return;
    }

    output.appendLine(
      `[${new Date().toISOString()}] Linting ${document.fileName} (${reason})`,
    );

    try {
      const lintCommand = await resolveLintCommand(projectRoot);
      const lintTargetPath = getLintTargetPath(projectRoot, document.fileName);
      const { stdout, stderr } = await execFileAsync(
        lintCommand.command,
        [...lintCommand.args, lintTargetPath],
        {
          cwd: projectRoot,
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      if (isStaleRun(document, currentRun, runCounters)) return;

      if (stderr.trim()) {
        output.appendLine(stderr.trim());
      }

      const diagnosticsForFile = parseDiagnostics(stdout, document);
      diagnostics.set(document.uri, diagnosticsForFile);
      updateStatusBar(
        statusBarItem,
        diagnosticsForFile.length > 0 ? "issues" : "success",
        document.fileName,
        diagnosticsForFile.length,
      );

      if (stdout.trim()) {
        output.appendLine(stdout.trim());
      }
    } catch (error) {
      if (isStaleRun(document, currentRun, runCounters)) return;

      diagnostics.set(document.uri, [
        new vscode.Diagnostic(
          firstLineRange(document),
          errorMessageFrom(error),
          vscode.DiagnosticSeverity.Error,
        ),
      ]);

      output.appendLine(errorMessageFrom(error));
      updateStatusBar(
        statusBarItem,
        "error",
        document.fileName,
        undefined,
        errorMessageFrom(error),
      );
    } finally {
      activeLintRuns = Math.max(0, activeLintRuns - 1);
      if (activeLintRuns === 0 && statusBarItem.text.includes("$(sync")) {
        updateStatusBar(statusBarItem, "idle");
      }
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void lintDocument(document, "save");
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) {
        diagnostics.delete(file);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      projectRootCache.clear();
      missingDependencyWarnings.clear();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "wrec.addDeclareStatementsCurrentFile",
      async () => {
        const document = vscode.window.activeTextEditor?.document;
        if (!document) return;
        await runDeclareDocument(document, output, statusBarItem);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrec.lintCurrentFile", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return;
      await lintDocument(document, "command");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrec.usedByCurrentFile", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document) return;
      await runUsedByDocument(document, output, statusBarItem);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("wrec.scaffoldComponent", async () => {
      await runScaffoldComponent(output, statusBarItem);
    }),
  );
}

// Provides the VS Code deactivate hook for completeness.
function deactivate() {}

// Determines whether the source text declares a class that extends Wrec.
function definesWrecClass(text) {
  return WREC_CLASS_RE.test(text);
}

// Maps each lint report section to the diagnostic severity shown in the editor.
function diagnosticSeverity(section) {
  if (
    section === "undefined properties" ||
    section === "undefined context functions" ||
    section === "undefined methods" ||
    section === "invalid event handler references" ||
    section === "type errors"
  ) {
    return vscode.DiagnosticSeverity.Error;
  }

  return vscode.DiagnosticSeverity.Warning;
}

// Runs the declare command for the current file and reports progress to the UI.
async function runDeclareDocument(document, output, statusBarItem) {
  if (!shouldProcessDocument(document)) return;

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return;

  updateStatusBar(statusBarItem, "running", document.fileName, undefined, {
    action: "declare",
  });

  const projectRoot = await findWrecProjectRoot(
    path.dirname(document.fileName),
    workspaceFolder.uri.fsPath,
    new Map(),
  );
  if (!projectRoot) {
    updateStatusBar(statusBarItem, "idle");
    vscode.window.showWarningMessage(
      "The Add declare Statements command only runs in workspaces whose package.json declares a dependency on wrec.",
    );
    return;
  }

  if (!definesWrecClass(document.getText())) {
    updateStatusBar(statusBarItem, "idle");
    return;
  }

  if (document.isDirty && !(await document.save())) {
    updateStatusBar(statusBarItem, "idle");
    vscode.window.showWarningMessage(
      "Save the current file before adding declare statements.",
    );
    return;
  }

  output.appendLine(
    `[${new Date().toISOString()}] Running declare for ${document.fileName}`,
  );

  try {
    const declareCommand = await resolveDeclareCommand(projectRoot);
    const targetPath = getLintTargetPath(projectRoot, document.fileName);
    const { stdout, stderr } = await execFileAsync(
      declareCommand.command,
      [...declareCommand.args, targetPath],
      {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (stderr.trim()) {
      output.appendLine(stderr.trim());
    }

    output.appendLine(stdout.trim() || "No declare output.");
    output.show(true);
    updateStatusBar(statusBarItem, "success", document.fileName, undefined, {
      action: "declare",
    });
  } catch (error) {
    output.appendLine(errorMessageFrom(error));
    output.show(true);
    updateStatusBar(statusBarItem, "error", document.fileName, undefined, {
      action: "declare",
      message: errorMessageFrom(error),
    });
    vscode.window.showErrorMessage(errorMessageFrom(error));
  }
}

// Normalizes execution errors into a readable message for users and logs.
function errorMessageFrom(error) {
  if (error && typeof error === "object") {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = error.message || "";
    if (stderr.includes("template.ts") && stderr.includes("ENOENT")) {
      return "The installed wrec package is missing scripts/template.ts, so the scaffold command cannot run.";
    }
    if (message.includes("template.ts") && message.includes("ENOENT")) {
      return "The installed wrec package is missing scripts/template.ts, so the scaffold command cannot run.";
    }
    return stderr || message || "Wrec linter failed.";
  }

  return String(error);
}

// Escapes special regex characters in arbitrary text before building a pattern.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the platform-specific executable name for a local CLI binary.
function executableName(baseName) {
  return process.platform === "win32" ? `${baseName}.cmd` : baseName;
}

// Checks whether a file or directory exists.
async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Chooses the best editor range to highlight for a reported lint issue.
function findBestRange(document, section, detail) {
  const explicitRange = parseLocatedRange(document, detail);
  if (explicitRange) return explicitRange;

  const candidateTerms = new Set();
  const quotedMatches = detail.matchAll(/"([^"]+)"/g);
  for (const match of quotedMatches) {
    const term = match[1].trim();
    if (term) candidateTerms.add(term);
  }

  const htmlTagMatches = detail.matchAll(/<([A-Za-z][\w-]*)>/g);
  for (const match of htmlTagMatches) {
    const tagName = match[1].trim();
    if (tagName) candidateTerms.add(`<${tagName}`);
  }

  if (
    section === "duplicate properties" ||
    section === "reserved property names" ||
    section === "undefined properties" ||
    section === "undefined context functions" ||
    section === "undefined methods"
  ) {
    candidateTerms.add(detail.trim());
  }

  for (const term of candidateTerms) {
    const range = findTermRange(document, term);
    if (range) return range;
  }

  return firstLineRange(document);
}

// Finds the first matching range for a term within a document.
function findTermRange(document, term) {
  const escaped = escapeRegExp(term);
  const patterns = [
    new RegExp(`\\b${escaped}\\b`, "g"),
    new RegExp(escaped, "g"),
  ];

  const text = document.getText();

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match || typeof match.index !== "number") continue;

    const start = document.positionAt(match.index);
    const end = document.positionAt(match.index + match[0].length);
    return new vscode.Range(start, end);
  }

  return undefined;
}

// Parses a leading :line:column prefix from a lint detail and creates a range.
function parseLocatedRange(document, detail) {
  const match = detail.match(/^:(\d+):(\d+)\b/);
  if (!match) return undefined;

  const line = Number(match[1]) - 1;
  const character = Number(match[2]) - 1;
  if (line < 0 || character < 0 || line >= document.lineCount) {
    return undefined;
  }

  const lineText = document.lineAt(line).text;
  const clampedCharacter = Math.min(character, lineText.length);
  return rangeForLocatedPosition(document, line, lineText, clampedCharacter);
}

// Expands a located lint position to a more visible token-sized editor range.
function rangeForLocatedPosition(document, line, lineText, character) {
  if (!lineText) {
    const position = new vscode.Position(line, 0);
    return new vscode.Range(position, position);
  }

  const candidateCharacters = [character];
  if (character > 0) {
    candidateCharacters.push(character - 1);
  }

  for (const candidateCharacter of candidateCharacters) {
    const position = new vscode.Position(line, candidateCharacter);
    const wordRange = document.getWordRangeAtPosition(position, /[\w$-]+/);
    if (wordRange) return wordRange;
  }

  if (character >= lineText.length) {
    const start = new vscode.Position(line, lineText.length - 1);
    const end = new vscode.Position(line, lineText.length);
    return new vscode.Range(start, end);
  }

  let startCharacter = character;
  let endCharacter = character;

  while (startCharacter > 0 && !/\s/.test(lineText[startCharacter - 1])) {
    startCharacter -= 1;
  }

  while (endCharacter < lineText.length && !/\s/.test(lineText[endCharacter])) {
    endCharacter += 1;
  }

  if (endCharacter > startCharacter) {
    const start = new vscode.Position(line, startCharacter);
    const end = new vscode.Position(line, endCharacter);
    return new vscode.Range(start, end);
  }

  const start = new vscode.Position(line, character);
  const end = new vscode.Position(line, Math.min(character + 1, lineText.length));
  return new vscode.Range(start, end);
}

// Removes a leading :line:column prefix from lint text before it is displayed.
function stripLocatedDetailPrefix(detail) {
  const strippedDetail = detail.replace(/^:\d+:\d+\|?\s*/, "").trimStart();
  return strippedDetail || detail;
}

// Walks upward to locate the nearest package that depends on wrec.
async function findWrecProjectRoot(startDirectory, workspaceRoot, cache) {
  let currentDirectory = startDirectory;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);

  while (isWithinDirectory(currentDirectory, normalizedWorkspaceRoot)) {
    const cachedProjectRoot = cache.get(currentDirectory);
    if (cachedProjectRoot !== undefined) {
      return cachedProjectRoot;
    }

    const packageJsonPath = path.join(currentDirectory, "package.json");

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8"),
      );
      if (hasWrecDependency(packageJson)) {
        cache.set(currentDirectory, currentDirectory);
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
    cache.set(currentDirectory, null);
    currentDirectory = parentDirectory;
  }

  cache.set(startDirectory, null);
  return null;
}

// Returns the range of the first line for fallback diagnostics.
function firstLineRange(document) {
  const firstLine = document.lineAt(0);
  return firstLine.range;
}

// Converts a file path to a project-relative CLI target when possible.
function getLintTargetPath(projectRoot, filePath) {
  const relativePath = path.relative(projectRoot, filePath);
  if (
    relativePath &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return filePath;
}

// Determines whether a package.json declares wrec in any dependency section.
function hasWrecDependency(packageJson) {
  const dependencySections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];

  return dependencySections.some((section) => Boolean(section && section.wrec));
}

// Tells whether a lint result belongs to an outdated run for the same document.
function isStaleRun(document, currentRun, runCounters) {
  return runCounters.get(document.uri.toString()) !== currentRun;
}

// Checks whether one path is contained within another directory.
function isWithinDirectory(candidatePath, parentPath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

// Determines whether a report line is an issue section heading from wrec lint.
function isIssueSectionHeader(line) {
  return !line.startsWith("  ") && line.endsWith(":");
}

// Builds the error message for a missing wrec CLI tool.
function missingCliMessage(tool) {
  return `The installed wrec package for this project does not include the wrec-${tool} CLI.`;
}
// Converts wrec lint output into VS Code diagnostics for the active document.
function parseDiagnostics(report, document) {
  if (!report || report.includes("no issues found")) return [];

  const diagnostics = [];
  const lines = report.split(/\r?\n/);
  let currentSection = "";

  for (const line of lines) {
    if (!line.trim()) continue;

    if (isIssueSectionHeader(line)) {
      currentSection = line.slice(0, -1);
      continue;
    }
    if (!currentSection) continue;
    if (!line.startsWith("  ")) continue;

    const detail = line.trim();
    const cleanedDetail = stripLocatedDetailPrefix(detail);
    const message = `${startCase(currentSection)}: ${cleanedDetail}`;
    diagnostics.push(
      new vscode.Diagnostic(
        findBestRange(document, currentSection, detail),
        message,
        diagnosticSeverity(currentSection),
      ),
    );
  }

  return diagnostics;
}

// Resolves how to run the wrec declare command from the local project install.
async function resolveDeclareCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-declare",
    errorMessage: WREC_DECLARE_MISSING_MESSAGE,
    scriptName: "declare.js",
  });
}

// Resolves how to run the wrec lint command from the local project install.
async function resolveLintCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-lint",
    errorMessage: WREC_LINT_MISSING_MESSAGE,
    scriptName: "lint.js",
  });
}

// Finds the best project root to use for commands that are not tied to a file.
async function resolveProjectRootForCommand() {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      activeDocument.uri,
    );
    if (workspaceFolder) {
      return findWrecProjectRoot(
        path.dirname(activeDocument.fileName),
        workspaceFolder.uri.fsPath,
        new Map(),
      );
    }
  }

  const [workspaceFolder] = vscode.workspace.workspaceFolders ?? [];
  if (!workspaceFolder) return null;

  return findWrecProjectRoot(
    workspaceFolder.uri.fsPath,
    workspaceFolder.uri.fsPath,
    new Map(),
  );
}

// Resolves how to run the wrec scaffold command from the local project install.
async function resolveScaffoldCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-scaffold",
    errorMessage: WREC_SCAFFOLD_MISSING_MESSAGE,
    scriptName: "scaffold.js",
  });
}

// Resolves how to run the wrec used-by command from the local project install.
async function resolveUsedByCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-usedby",
    errorMessage: WREC_USED_BY_MISSING_MESSAGE,
    scriptName: "used-by.js",
  });
}

// Resolves a wrec CLI either from a packaged script or a local .bin executable.
async function resolveWrecCommand(projectRoot, options) {
  const packagedScriptPath = path.join(
    projectRoot,
    "node_modules",
    "wrec",
    "scripts",
    options.scriptName,
  );
  if (await fileExists(packagedScriptPath)) {
    return { command: process.execPath, args: [packagedScriptPath] };
  }

  const localBinPath = path.join(
    projectRoot,
    "node_modules",
    ".bin",
    executableName(options.binName),
  );
  if (await fileExists(localBinPath)) {
    return { command: localBinPath, args: [] };
  }

  throw new Error(options.errorMessage);
}

// Prompts for a tag name and runs the scaffold command in the current project.
async function runScaffoldComponent(output, statusBarItem) {
  const projectRoot = await resolveProjectRootForCommand();
  if (!projectRoot) {
    updateStatusBar(statusBarItem, "idle");
    vscode.window.showWarningMessage(
      "The Scaffold Component command requires an open workspace that depends on wrec.",
    );
    return;
  }

  const tagName = await vscode.window.showInputBox({
    ignoreFocusOut: true,
    placeHolder: "my-element",
    prompt: "Enter the custom element tag name to scaffold.",
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "A tag name is required.";
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(trimmed)) {
        return "Tag names must be lowercase and include at least one hyphen.";
      }
      return undefined;
    },
  });

  if (tagName === undefined) return;

  const trimmedTagName = tagName.trim();
  updateStatusBar(statusBarItem, "running", trimmedTagName, undefined, {
    action: "scaffold",
  });
  output.appendLine(
    `[${new Date().toISOString()}] Scaffolding ${trimmedTagName} in ${projectRoot}`,
  );

  try {
    const scaffoldCommand = await resolveScaffoldCommand(projectRoot);
    const { stdout, stderr } = await execFileAsync(
      scaffoldCommand.command,
      [...scaffoldCommand.args, trimmedTagName],
      {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (stderr.trim()) {
      output.appendLine(stderr.trim());
    }

    output.appendLine(stdout.trim() || `Scaffolded ${trimmedTagName}.`);
    output.show(true);
    updateStatusBar(statusBarItem, "success", trimmedTagName, undefined, {
      action: "scaffold",
    });
    vscode.window.showInformationMessage(
      `Wrec scaffold completed for ${trimmedTagName}.`,
    );
  } catch (error) {
    output.appendLine(errorMessageFrom(error));
    output.show(true);
    updateStatusBar(statusBarItem, "error", trimmedTagName, undefined, {
      action: "scaffold",
      message: errorMessageFrom(error),
    });
    vscode.window.showErrorMessage(errorMessageFrom(error));
  }
}

// Runs the used-by command for the current file and reports progress to the UI.
async function runUsedByDocument(document, output, statusBarItem) {
  if (!shouldProcessDocument(document)) return;

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) return;

  updateStatusBar(statusBarItem, "running", document.fileName, undefined, {
    action: "used-by",
  });

  const projectRoot = await findWrecProjectRoot(
    path.dirname(document.fileName),
    workspaceFolder.uri.fsPath,
    new Map(),
  );
  if (!projectRoot) {
    updateStatusBar(statusBarItem, "idle");
    vscode.window.showWarningMessage(
      "The Used By command only runs in workspaces whose package.json declares a dependency on wrec.",
    );
    return;
  }

  if (!definesWrecClass(document.getText())) {
    updateStatusBar(statusBarItem, "idle");
    vscode.window.showWarningMessage(
      "The current file does not define a class that extends Wrec.",
    );
    return;
  }

  output.appendLine(
    `[${new Date().toISOString()}] Running used-by for ${document.fileName}`,
  );

  try {
    const usedByCommand = await resolveUsedByCommand(projectRoot);
    const targetPath = getLintTargetPath(projectRoot, document.fileName);
    const { stdout, stderr } = await execFileAsync(
      usedByCommand.command,
      [...usedByCommand.args, targetPath],
      {
        cwd: projectRoot,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (stderr.trim()) {
      output.appendLine(stderr.trim());
    }

    output.appendLine(stdout.trim() || "No used-by output.");
    output.show(true);
    updateStatusBar(statusBarItem, "success", document.fileName, undefined, {
      action: "used-by",
    });
  } catch (error) {
    output.appendLine(errorMessageFrom(error));
    output.show(true);
    updateStatusBar(statusBarItem, "error", document.fileName, undefined, {
      action: "used-by",
      message: errorMessageFrom(error),
    });
    vscode.window.showErrorMessage(errorMessageFrom(error));
  }
}

// Limits processing to supported file-backed JavaScript and TypeScript documents.
function shouldProcessDocument(document) {
  return (
    document.uri.scheme === "file" &&
    SUPPORTED_LANGUAGE_IDS.has(document.languageId)
  );
}

// Capitalizes the first character of a string for display purposes.
function startCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Updates the status bar text, tooltip, and colors for the current Wrec action.
function updateStatusBar(
  statusBarItem,
  state,
  fileName,
  issueCount,
  details = {},
) {
  const fileLabel = fileName ? path.basename(fileName) : undefined;
  const action = details.action ?? "lint";
  const actionHint =
    action === "declare"
      ? "Use the command palette to add declare statements."
      : action === "used-by"
        ? "Use the command palette to run Set usedBy Properties."
        : action === "scaffold"
          ? "Use the command palette to scaffold a component."
          : "Lint runs automatically on save.";

  switch (state) {
    case "running":
      statusBarItem.text =
        action === "declare"
          ? `$(sync~spin) Wrec declare`
          : action === "used-by"
            ? `$(sync~spin) Wrec used by`
            : action === "scaffold"
              ? `$(sync~spin) Wrec scaffold`
              : `$(sync~spin) Wrec lint`;
      statusBarItem.tooltip = fileLabel
        ? action === "declare"
          ? `Wrec is adding declare statements in ${fileLabel}. ${actionHint}`
          : action === "used-by"
            ? `Wrec is running used by for ${fileLabel}. ${actionHint}`
            : action === "scaffold"
              ? `Wrec is scaffolding ${fileLabel}. ${actionHint}`
              : `Wrec is linting ${fileLabel}. ${actionHint}`
        : action === "declare"
          ? `Wrec is adding declare statements. ${actionHint}`
          : action === "used-by"
            ? `Wrec is running used by. ${actionHint}`
            : action === "scaffold"
              ? `Wrec is scaffolding a component. ${actionHint}`
              : `Wrec is linting. ${actionHint}`;
      statusBarItem.backgroundColor = undefined;
      return;
    case "issues":
      statusBarItem.text = `$(warning) Wrec ${issueCount}`;
      statusBarItem.tooltip = fileLabel
        ? `Wrec found ${issueCount} issue${issueCount === 1 ? "" : "s"} in ${fileLabel}. ${actionHint}`
        : `Wrec found ${issueCount} issue${issueCount === 1 ? "" : "s"}. ${actionHint}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      return;
    case "error":
      statusBarItem.text = `$(error) Wrec error`;
      statusBarItem.tooltip = details.message
        ? action === "declare"
          ? `Wrec declare failed: ${details.message}`
          : action === "used-by"
            ? `Wrec used by failed: ${details.message}`
            : action === "scaffold"
              ? `Wrec scaffold failed: ${details.message}`
              : `Wrec lint failed: ${details.message}`
        : action === "declare"
          ? `Wrec declare failed. ${actionHint}`
          : action === "used-by"
            ? `Wrec used by failed. ${actionHint}`
            : action === "scaffold"
              ? `Wrec scaffold failed. ${actionHint}`
              : `Wrec lint failed. ${actionHint}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      return;
    case "success":
      statusBarItem.text = `$(pass) Wrec ok`;
      statusBarItem.tooltip = fileLabel
        ? action === "declare"
          ? `Wrec added declare statements in ${fileLabel}. ${actionHint}`
          : action === "used-by"
            ? `Wrec finished used by for ${fileLabel}. ${actionHint}`
            : action === "scaffold"
              ? `Wrec scaffolded ${fileLabel}. ${actionHint}`
              : `Wrec found no issues in ${fileLabel}. ${actionHint}`
        : action === "declare"
          ? `Wrec finished adding declare statements. ${actionHint}`
          : action === "used-by"
            ? `Wrec finished used by. ${actionHint}`
            : action === "scaffold"
              ? `Wrec finished scaffolding. ${actionHint}`
              : `Wrec found no issues. ${actionHint}`;
      statusBarItem.backgroundColor = undefined;
      return;
    default:
      statusBarItem.text = `$(check) Wrec active`;
      statusBarItem.tooltip = "Wrec Lint On Save is active.";
      statusBarItem.backgroundColor = undefined;
  }
}

module.exports = {
  activate,
  deactivate,
};
