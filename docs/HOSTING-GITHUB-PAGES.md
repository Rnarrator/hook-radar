# Hosting on GitHub Pages

This is the route the project's workflow is written for, and the only one the workflow deploys by itself.

## Set up

1. Put this folder in a **public** repository (see the start-here guide in the root README, which publishes it private first so that you can add a licence, then makes it public). Free GitHub Pages needs a public repository at the time of writing.
2. In the repository open **Settings, Pages**. Under "Build and deployment" choose **Source: GitHub Actions**. Do not choose "Deploy from a branch".
3. Open **Actions, Snapshot, Run workflow** once. After that GitHub starts it by itself three times an hour and it collects about once an hour. GitHub may start a run late, or not at all, when it is busy.

The site is at `https://USERNAME.github.io/REPOSITORY/`. If the repository is named `USERNAME.github.io` the site is at `https://USERNAME.github.io/`.

## What the Snapshot workflow does

`.github/workflows/snapshot.yml` has three jobs.

**Is a new snapshot due** runs first and takes a few seconds. It reads when the last snapshot was saved (the time in `state/pools.json`) and contacts no data service. The workflow is started three times an hour, at 7, 27 and 47 minutes past, so that when GitHub starts one late or not at all another may still arrive, and this job lets only one of them collect: when the last snapshot is under 45 minutes old, or a run failed under 90 minutes ago, it ends the run with a green tick and "Nothing to do" in the run summary, and the other two jobs are skipped. A saved time that cannot be read means collect. A run started by hand with **Run workflow** always collects unless you untick "force"; tick "discover" to also look for new pools. Scheduled runs look for new pools in at most one run in each three-hour block of the UTC day: the first one that finds the last snapshot saved in an earlier block. A run that fails, in any job, holds the next collecting run back until 90 minutes after the failure. If only the last job, "Publish to GitHub Pages", fails, the new snapshot is saved but not shown, and the site waits about 90 minutes or more for the next one.

**Collect and build** (needs permission to write to the repository, which the workflow requests for itself):

1. Checks out the repository and installs Node 24 and the packages (`npm ci`).
2. Checks that GitHub Pages is switched on, **before** any data service is contacted.
3. Works out the site's address from the repository name (see below).
4. Runs `node collector/run.mjs`. If it refuses to publish, the job stops here.
5. Builds the page with the data files next to it (`npm run build:static -- --require-data`).
6. Checks the data files that are about to be published: they must be a snapshot from a live collection (not an offline test replay) and agree on the time of the run. If not, the job stops here.
7. Commits `state/` back to the branch with the message "Update snapshot state [skip ci]".
8. Uploads the built site for Pages.

**Publish to GitHub Pages** runs only if **Collect and build** finished without error. So a failed collection never replaces the site; it keeps the last good snapshot. When the first job says nothing is due, this job is skipped too and the site stays as it was.

Only one Snapshot run happens at a time. A run that starts while another is active waits.

## The site's address and the "base" setting

The page is built knowing the folder it will be served from:

| Situation                                                                                | Base used                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------------- |
| Normal project site, `https://USERNAME.github.io/REPOSITORY/`                            | `/REPOSITORY/`                              |
| Repository named `USERNAME.github.io`                                                    | `/`                                         |
| A file named `CNAME` exists in `public/` or at the top of the repository (custom domain) | `./` (relative; works at the domain's root) |

If you add a custom domain, create the `CNAME` file as well as setting the domain in Settings, Pages. See [HOSTING-NAMECHEAP.md](HOSTING-NAMECHEAP.md).

## Compression

`data/snapshot.json` is about 10 MB as plain JSON (measured on a recent real snapshot) and about 1 MB once compressed with gzip; it grows with the number of measured pools. The host has to send it compressed: on a slow phone connection the plain file takes several times longer to arrive, and every visit pays that cost.

GitHub Pages compresses text files, JSON included, by itself; there is nothing to switch on. This was checked on 28 October 2026 against a public Pages site: a JSON file answered with `Content-Encoding: gzip`. Check your own site once the first run has published:

```
curl -H "Accept-Encoding: gzip" -I https://USERNAME.github.io/REPOSITORY/data/snapshot.json
```

The reply should contain `Content-Encoding: gzip`. If that line is missing, the file is being sent whole; the page still works, only slowly.

## A return visit and a page left open

To start faster, the page asks for `data/snapshot.json` while it is still loading its scripts. That request asks the host whether the file changed, on every visit, so a visitor who comes back sees the latest published snapshot even though GitHub Pages lets browsers keep files for 10 minutes. A page that stays open does not swap its figures behind the reader's back: every 15 minutes, while the tab is visible, it reads only the small `data/status.json` and, when a later snapshot exists, adds a sentence and a **Reload** button to the dated line. The page always states when its snapshot was taken.

## Looking at a run

Actions tab, then the run, then the step. The most useful ones:

- **Decide** (in "Is a new snapshot due"): says in one line whether the run collects and why ("Nothing to do: the last snapshot is 12 minutes old", "Collecting: the last snapshot is 58 minutes old").
- **Collect the snapshot**: the collector prints what it did, which providers it used and, when it refuses, why.
- **Build the site**: type or build errors.
- **Check that the data is a live snapshot**: lists what is wrong with the data files when it fails. Nothing is published then.
- **Save state**: the push of the `state` folder.

## When something goes wrong

| What you see                                                                    | Likely cause and fix                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Check that GitHub Pages is switched on" fails with "Not Found"                 | Settings, Pages, Source is not set to GitHub Actions yet, or the repository is private on a plan without Pages                                                                                                                                              |
| The site address shows GitHub's 404 page                                        | The first run has not finished or did not succeed (a red cross on the run), or Pages is not set to GitHub Actions. Until one run is green there is no site to show                                                                                          |
| The page is blank or looks unstyled and the browser console shows missing files | The address and the build disagree. You added a custom domain in Settings but there is no `CNAME` file, or the repository was renamed. Add or fix the file (or re-run after renaming) and run Snapshot again                                                |
| "Collect the snapshot" fails                                                    | Read its output. The collector refuses to publish when fewer than 500 hooked pools have a current 24-hour volume, when a provider refused or rate-limited it, or when the data failed its checks. Nothing was published; the next scheduled run tries again |
| "Save state" fails to push                                                      | Branch protection on `main` rejects the workflow's commit. Either allow the GitHub Actions bot to push (or bypass the rule) for this branch, or do not protect it. A failed push stops the deploy, so the site stays on the last snapshot                   |
| "Publish to GitHub Pages" is refused by the environment                         | The `github-pages` environment only allows deployments from certain branches. If you run the workflow from a branch other than `main`, add that branch under Settings, Environments, github-pages                                                           |
| Runs stop appearing                                                             | GitHub can switch scheduled jobs off in a public repository after a long time without activity. Actions, Snapshot, **Enable workflow**                                                                                                                      |

## Keeping it up to date

The workflow pins the versions of the GitHub actions it uses. `.github/dependabot.yml` asks Dependabot to open a pull request when a newer one exists. Nothing changes until you merge it.
