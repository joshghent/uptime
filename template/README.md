# Status page

Built on [@joshghent/uptime](https://github.com/joshghent/uptime). Your
monitors are in `status.yaml`; everything else comes from the package.

```sh
npm run lint     # check status.yaml
npm run dev      # run it locally, with .dev.vars for secrets
npm run check    # what CI runs: lint, build, boot
```

Pushing to `main` deploys. Updates arrive as Dependabot pull requests and merge
themselves once `npm run check` passes; majors wait for you, and their release
notes say what to do.
