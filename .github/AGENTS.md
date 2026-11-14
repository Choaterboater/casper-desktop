# .github

`workflows/casper-ci.yml` is the only workflow: on pull requests and pushes to `main` it runs the static gates, typecheck, lint and unit tests on GitHub-hosted Ubuntu runners. GitHub runs every `.yml` or `.yaml` file placed in `workflows/`, and [scripts/casper-workflows.spec.ts](../scripts/casper-workflows.spec.ts) fails the unit tests while that folder holds any other file. When an upstream merge adds a workflow file, delete it before pushing the merge branch, because GitHub runs a workflow that a pull request adds on that pull request.
