"use strict";

const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const WREC_CLASS_RE = /\bclass\s+[A-Za-z_$][\w$]*\s+extends\s+Wrec\b/;
const WREC_LINT_MISSING_MESSAGE =
  "The installed wrec package for this project does not include the wrec-lint CLI. Publish/install a wrec version that ships scripts/lint.js and the wrec-lint bin.";
const WREC_USED_BY_MISSING_MESSAGE =
  "The installed wrec package for this project does not include the wrec-used-by CLI. Publish/install a wrec version that ships scripts/used-by.js and the wrec-used-by bin.";
const WREC_SCAFFOLD_MISSING_MESSAGE =
  "The installed wrec package for this project does not include the wrec-scaffold CLI. Publish/install a wrec version that ships scripts/scaffold.js and the wrec-scaffold bin.";
const WREC_SCAFFOLD_TEMPLATE = `import {css, html, Wrec} from 'wrec';

class {class} extends Wrec {
  static properties = {
    name: {type: String, value: 'World'},
  };

  static css = css\`
    p {
      color: blue;
      font-family: fantasy;
    }
  \`;

  static html = html\`
    <p>Hello, <span>this.name</span>!</p>
  \`;
}

{class}.define('{tag}');
`;
const SUPPORTED_LANGUAGE_IDS = new Set([
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
]);
const ISSUE_SECTIONS = new Set([
  "duplicate properties",
  "reserved property names",
  "invalid usedBy references",
  "invalid computed properties",
  "invalid values configurations",
  "invalid default values",
  "invalid form-assoc values",
  "missing formAssociated property",
  "missing type properties",
  "undefined properties",
  "undefined context functions",
  "undefined methods",
  "invalid event handler references",
  "invalid useState map entries",
  "incompatible arguments",
  "type errors",
  "unsupported html attributes",
  "unsupported event names",
  "invalid html nesting",
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
  statusBarItem.command = "wrec.lintCurrentFile";
  statusBarItem.show();
  updateStatusBar(statusBarItem, "idle");

  context.subscriptions.push(diagnostics, output, statusBarItem);

  async function lintDocument(document, reason = "manual") {
    if (!shouldProcessDocument(document)) {
      diagnostics.delete(document.uri);
      return;
    }

    const config = getConfig(document);

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
      maybeShowOutput(output, config.showOutput, diagnosticsForFile.length > 0);
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
      maybeShowOutput(output, config.showOutput, true);
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

// Normalizes execution errors into a readable message for users and logs.
function errorMessageFrom(error) {
  if (error && typeof error === "object") {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const message = error.message || "";
    return stderr || message || "Wrec linter failed.";
  }

  return String(error);
}

// Detects when scaffold should fall back to the built-in template.
function isMissingScaffoldCommandError(error) {
  return errorMessageFrom(error) === WREC_SCAFFOLD_MISSING_MESSAGE;
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

// Reads extension settings for the current document.
function getConfig(document) {
  const config = vscode.workspace.getConfiguration("wrec", document.uri);
  return {
    showOutput: config.get("showOutput", "onIssues"),
  };
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

// Shows or hides the output channel based on the configured display mode.
function maybeShowOutput(output, mode, hasIssues) {
  if (mode === "always") {
    output.show(true);
    return;
  }

  if (mode === "onIssues" && hasIssues) {
    output.show(true);
    return;
  }

  output.hide();
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
  const clickHint =
    action === "used-by"
      ? "Click to run Used By on the current file."
      : action === "scaffold"
        ? "Use the command palette to scaffold a component."
      : "Click to lint the current file.";

  switch (state) {
    case "running":
      statusBarItem.text =
        action === "used-by"
          ? `$(sync~spin) Wrec used by`
          : action === "scaffold"
            ? `$(sync~spin) Wrec scaffold`
            : `$(sync~spin) Wrec lint`;
      statusBarItem.tooltip = fileLabel
        ? action === "used-by"
          ? `Wrec is running used by for ${fileLabel}. ${clickHint}`
          : action === "scaffold"
            ? `Wrec is scaffolding ${fileLabel}. ${clickHint}`
          : `Wrec is linting ${fileLabel}. ${clickHint}`
        : action === "used-by"
          ? `Wrec is running used by. ${clickHint}`
          : action === "scaffold"
            ? `Wrec is scaffolding a component. ${clickHint}`
          : `Wrec is linting. ${clickHint}`;
      statusBarItem.backgroundColor = undefined;
      return;
    case "issues":
      statusBarItem.text = `$(warning) Wrec ${issueCount}`;
      statusBarItem.tooltip = fileLabel
        ? `Wrec found ${issueCount} issue${issueCount === 1 ? "" : "s"} in ${fileLabel}. ${clickHint}`
        : `Wrec found ${issueCount} issue${issueCount === 1 ? "" : "s"}. ${clickHint}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      return;
    case "error":
      statusBarItem.text = `$(error) Wrec error`;
      statusBarItem.tooltip = details.message
        ? action === "used-by"
          ? `Wrec used by failed: ${details.message}`
          : action === "scaffold"
            ? `Wrec scaffold failed: ${details.message}`
          : `Wrec lint failed: ${details.message}`
        : action === "used-by"
          ? `Wrec used by failed. ${clickHint}`
          : action === "scaffold"
            ? `Wrec scaffold failed. ${clickHint}`
          : `Wrec lint failed. ${clickHint}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground",
      );
      return;
    case "success":
      statusBarItem.text = `$(pass) Wrec ok`;
      statusBarItem.tooltip = fileLabel
        ? action === "used-by"
          ? `Wrec finished used by for ${fileLabel}. ${clickHint}`
          : action === "scaffold"
            ? `Wrec scaffolded ${fileLabel}. ${clickHint}`
          : `Wrec found no issues in ${fileLabel}. ${clickHint}`
        : action === "used-by"
          ? `Wrec finished used by. ${clickHint}`
          : action === "scaffold"
            ? `Wrec finished scaffolding. ${clickHint}`
          : `Wrec found no issues. ${clickHint}`;
      statusBarItem.backgroundColor = undefined;
      return;
    default:
      statusBarItem.text = `$(check) Wrec active`;
      statusBarItem.tooltip =
        "Wrec Lint On Save is active. Click to lint the current file.";
      statusBarItem.backgroundColor = undefined;
  }
}

// Converts wrec lint output into VS Code diagnostics for the active document.
function parseDiagnostics(report, document) {
  if (!report || report.includes("no issues found")) return [];

  const diagnostics = [];
  const lines = report.split(/\r?\n/);
  let currentSection = "";

  for (const line of lines) {
    if (!line.trim()) continue;

    if (!line.startsWith("  ") && line.endsWith(":")) {
      currentSection = line.slice(0, -1);
      continue;
    }

    if (!ISSUE_SECTIONS.has(currentSection)) continue;
    if (!line.startsWith("  ")) continue;

    const message = `${startCase(currentSection)}: ${line.trim()}`;
    diagnostics.push(
      new vscode.Diagnostic(
        findBestRange(document, currentSection, line.trim()),
        message,
        diagnosticSeverity(currentSection),
      ),
    );
  }

  return diagnostics;
}

// Resolves how to run the wrec lint command from the local project install.
async function resolveLintCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-lint",
    errorMessage: WREC_LINT_MISSING_MESSAGE,
    scriptName: "lint.js",
  });
}

// Resolves how to run the wrec used-by command from the local project install.
async function resolveUsedByCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-used-by",
    errorMessage: WREC_USED_BY_MISSING_MESSAGE,
    scriptName: "used-by.js",
  });
}

// Resolves how to run the wrec scaffold command from the local project install.
async function resolveScaffoldCommand(projectRoot) {
  return resolveWrecCommand(projectRoot, {
    binName: "wrec-scaffold",
    errorMessage: WREC_SCAFFOLD_MISSING_MESSAGE,
    scriptName: "scaffold.js",
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
    return { command: "node", args: [packagedScriptPath] };
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

// Creates a scaffolded component file from the built-in extension template.
async function scaffoldComponentLocally(projectRoot, tagName) {
  const className = toClassName(tagName);
  const outputPath = path.join(projectRoot, `${tagName}.ts`);
  const output = WREC_SCAFFOLD_TEMPLATE.replaceAll("{class}", className)
    .replaceAll("{tag}", tagName);

  await fs.writeFile(outputPath, output, { flag: "wx" });
  return outputPath;
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
    let scaffoldOutput = `Scaffolded ${trimmedTagName}.`;

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

      if (stdout.trim()) {
        scaffoldOutput = stdout.trim();
      }
    } catch (error) {
      if (!isMissingScaffoldCommandError(error)) {
        throw error;
      }

      const outputPath = await scaffoldComponentLocally(
        projectRoot,
        trimmedTagName,
      );
      scaffoldOutput =
        `Scaffolded ${trimmedTagName} at ${outputPath} using the built-in template.`;
    }

    output.appendLine(scaffoldOutput);
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

// Finds the best project root to use for commands that are not tied to a file.
async function resolveProjectRootForCommand() {
  const activeDocument = vscode.window.activeTextEditor?.document;
  if (activeDocument) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(activeDocument.uri);
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

// Converts a custom element tag name into a component class name.
function toClassName(tagName) {
  return tagName
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

module.exports = {
  activate,
  deactivate,
};
