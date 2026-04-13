# wrec

This VS Code extension adds three commands that are helpful when implementing
[wrec](https://github.com/mvolkmann/wrec) web components.

## Commands

- wrec: Scaffold New Component

  This prompts for a tag name and generates a `.ts` file
  containing starter code for a new web component
  where the class name is the CamelCase version of the tag name.

- wrec: Lint Current File

  This runs wrec-specific linting checks
  on the currently open and focused source file.
  While this is running, "Wrec lint" will be displayed in the status bar.
  When it completes, the status bar will display
  either "Wrec ok" or "Wrec {issue-count"}".
  If any issues are discovered,
  they are appended to the "OUTPUT" panel,
  which you can open manually by
  selecting View ... Output (cmd-shift-u) to review them there.
  Also, lines where the issues are found are marked with
  a yellow squiggly and hovering over it displays an error message.

- wrec: Set usedBy Properties in Current File

  This adds/updates `usedBy` properties in the property configuration objects
  found in the `static properties =` object.
  These are necessary when reactive JavaScript expressions
  do not explicitly reference every property they use.
  In that case, wrec relies on `usedBy` properties,
  to determine when to reevaluate the expressions.

All these commands run a script in the wrec package.
The `package.json` file for the project that is opened in VS Code
must have a dependency on the wrec package and
it must be installed to use these commands.

## Lint Issues

The lint issues detected include:

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
