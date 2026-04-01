# wrec Linter

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
