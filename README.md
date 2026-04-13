# wrec Linter

This VS Code extension runs `npx wrec-lint <file>` whenever you save
a JavaScript or TypeScript file that defines a class extending `Wrec`.

It only runs in workspaces whose `package.json` declares a dependency on `wrec`.

The issues detected include:

- undefined properties accessed in expressions
- undefined instance methods called in expressions
- undefined context functions called in expressions
- extra arguments passed to methods and context functions
- incompatible method arguments in expressions
- incompatible context function arguments in expressions
- arithmetic type errors in expressions
- invalid computed property references and calls to non-method members
- invalid event handler references
- unsupported event names
- duplicate property names
- reserved property names
- missing `type` in property configurations
- invalid default values
- invalid `values` configurations
- invalid `usedBy` references
- missing `formAssociated` when `formAssociatedCallback` is defined
- invalid `form-assoc` values
- invalid `useState` map entries
- unsupported HTML attributes in templates
- invalid HTML element nesting in templates
- invalid ref attribute targets
- duplicate ref attribute values

Lint output is written to the `Wrec Lint` output channel,
and reported issues are surfaced as diagnostics in the editor.
The extension also adds a status bar item so you can tell when it is active
and when linting is in progress.

## Settings

- `wrec.showOutput`: `never`, `onIssues`, or `always`

## Command

- `wrec: Lint Current File`
- `wrec: Used By Current File`
- `wrec: Scaffold Component`

The scaffold command prompts for a custom element tag name and passes it to the
Wrec scaffold script. If the installed `wrec` package does not publish that CLI,
the extension falls back to the built-in Wrec component template.

## Status Bar

The status bar item:

- shows `Wrec active` after the extension activates
- shows a spinner while linting is running
- shows an issue count when linting finds problems
- shows an error state if the lint command fails
- can be clicked to lint the current file manually
