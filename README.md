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

Lint output is written to the `Wrec Lint` output channel,
and reported issues are surfaced as diagnostics in the editor.

## Settings

- `wrec.showOutput`: `never`, `onIssues`, or `always`

## Command

- `wrec: Lint Current File`

## Publishing

To publish a new version,
bump the version number in `package.json`
and run the following commands.

```bash
npm install
npm run package
npm run publish # requires a valid Azure DevOps personal access token
```

To publish without using `npm run publish`:

- browse https://marketplace.visualstudio.com/manage/publishers/rmarkvolkmann,
- click the vertical ellipsis after the extension name "wrec"
- select "Update"
- drag the new `.vsix` file into the dialog

It may take several minutes to verify the new version
before it becomes live in the Marketplace.
