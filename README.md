# wrec Linter

This VS Code extension runs `npx wrec-lint <file>` whenever you save
a JavaScript or TypeScript file that defines a class extending `Wrec`.

It only runs in workspaces whose `package.json` declares a dependency on `wrec`.

Lint output is written to the `Wrec Lint` output channel,
and reported issues are surfaced as diagnostics in the editor.

## Settings

- `wrec.enabled`: enable or disable the extension
- `wrec.npxPath`: path to the `npx` executable
- `wrec.showOutput`: `never`, `onIssues`, or `always`

## Command

- `Wrec: Lint Current File`

## Publishing

To publish a new version,
bump the version number in `package.json`
and run the following commands.

```bash
npm install
npm run package
npm run publish
```

Then browse https://marketplace.visualstudio.com/manage/publishers/rmarkvolkmann,
click the vertical ellipsis after the extension name "wrec",
select "Update", and drag the new `.vsix` file into the dialog.
It may take around 10 minutes to verify the new version
before it becomes live in the Marketplace.
