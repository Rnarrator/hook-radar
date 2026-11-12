# Hook Radar, Auto Snapshot edition

**What to do**

- Put this folder on GitHub as a repository, choose a licence and make it public, set GitHub Pages to **GitHub Actions**, and press **Run workflow**. The numbered steps below show where to click: about 10 minutes of your own time.
- Then wait about 15 minutes while the first run finishes on GitHub's side. After that the site refreshes by itself.

Hook Radar is a website for exploring Uniswap v4 hooks: which projects use them, which pools they sit on, and how much trading those pools have recently seen.

This folder is the **Auto Snapshot edition**. It is the same Hook Radar page, published as plain files that **refresh themselves about every hour when GitHub starts the runs, and less often when GitHub is busy, with nothing of yours switched on**. A scheduled job in GitHub's cloud collects a sample of hook pools from public data services, builds the data files, builds the page and publishes it. Visitors only download files. The page never calls a data service itself.

It is a different edition from the always-on Hook Radar server, and it works differently in one honest way: every figure on the page belongs to the **snapshot**, which is taken about once an hour, not to the moment you look. The page says so at the top, with the time of the snapshot. [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) explains the rule in plain words.

## Publish it: about 10 minutes of your time

You need a free GitHub account and [GitHub Desktop](https://desktop.github.com/). Menu names below are as GitHub shows them at the time of writing; if one has moved, the words are usually still easy to find.

1. **Add this folder to GitHub Desktop.** File, Add local repository, choose this folder. GitHub Desktop says it is not a Git repository yet: press **create a repository**, leave the options as they are (do not tick "Initialize this repository with a README"), and press **Create repository**. Then tick all the files and press **Commit to main** to make the first commit. (If the folder you were given already holds a first commit, skip this.)
2. **Publish the repository, private for now.** Press **Publish repository**. Give it a name such as `hook-radar`, choose your account, and make sure **"Keep this code private"** is ticked. This creates the repository on github.com and uploads the folder in one step. The first commit carries the name and e-mail address from GitHub Desktop's settings (File, Options, Git). GitHub shows them publicly once the repository is public; if you would rather not show your e-mail address, choose your GitHub no-reply address there before you commit (github.com, Settings, Emails shows it). (A folder assembled with the option `--init-git` already holds a first commit; whoever assembled it can choose its identity with `--author-name` and `--author-email`.) If you would rather create the empty repository on github.com first, choose Private there and do not tick "Add a README", ".gitignore" or a licence; then paste its address under Repository, Repository settings, Remote, and press Push origin.
3. **Choose a licence.** On github.com open the repository, press **Add file**, **Create new file**, name it `LICENSE` and use the licence template picker, then press **Review and submit** and **Commit changes**; without one nobody may legally reuse your code. The data and the logos on the site are not yours to licence: see [docs/PROVIDER-TERMS.md](docs/PROVIDER-TERMS.md).
4. **Make the repository public.** On github.com open Settings, then General, scroll down to the Danger Zone, press **Change visibility** and choose to make the repository public. Confirm as GitHub asks. Free GitHub Pages needs a public repository at the time of writing (see "What it costs").
5. **Switch on GitHub Pages.** One note first: once Pages is on, the job also starts by itself within the hour, not only when you press Run workflow, and it asks the v4.xyz indexer, whose two paths are not a documented public API. See [docs/PROVIDER-TERMS.md](docs/PROVIDER-TERMS.md) item 1. If you want to wait for the v4.xyz maintainers' answer, make the one-line edit there before you switch Pages on. Then, in the repository on github.com, open Settings, then Pages. Under "Build and deployment" set **Source** to **GitHub Actions**. (If a scheduled run already failed on the step "Check that GitHub Pages is switched on", that is harmless: it stops before any data service is contacted.)
6. **Run the Snapshot job once.** Open the Actions tab, choose **Snapshot** in the list on the left, press **Run workflow**, then the green **Run workflow** button. If GitHub shows a button asking to enable workflows, press it. This first run measures the pools the folder already knows and does not look for new pools; to make it do that too, tick **discover** in the same box. The scheduled runs look for new pools on their own, from the next three-hour block of the UTC day on.
7. **Wait.** The first run takes about 15 minutes, because the collector pauses between requests on purpose to be polite to the data services. The workflow stops a run that exceeds 45 minutes. When all three jobs ("Is a new snapshot due", "Collect and build", then "Publish to GitHub Pages") have a green tick, the site is live. If a job shows a red cross instead, nothing was published and there is no site yet: see "How you find out" below.
8. **Open the site.** It is at `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`. The address is also shown in Settings, Pages, and on the finished run.

One thing to know about the finished page:

- **Open it from a web address.** Opening `index.html` from a folder on your computer (a double-click) shows a blank page: a browser does not let a page opened from a file read the data files next to it. To look at a build on your own computer, run `npm run preview` (see "For people who work on the code") and open the address it prints.

Before you tell people about the site, read [docs/PROVIDER-TERMS.md](docs/PROVIDER-TERMS.md). It lists which data services are used, what each one asks of you, and one permission you should obtain.

## What happens after that

- **Refresh rhythm.** GitHub is asked to start the Snapshot job three times an hour (at 7, 27 and 47 minutes past, UTC). Its first step, "Is a new snapshot due", reads when the last snapshot was saved and lets only one of those starts collect: the others finish after a few seconds with a green tick and the words "Nothing to do" in the run summary, publish nothing and ask no data service anything. So the site is refreshed about every hour, and the Actions list shows many short green runs a day: that is normal. A run is also held back for 90 minutes after one that failed.
  GitHub may start a scheduled run late, or not at all, when it is busy, so the site can be older than an hour; the page always states the time of its snapshot. GitHub's own schedule is best effort, and in practice it has gone quiet for hours (from 17:07 UTC on 11 November to 02:32 UTC on 12 November 2026 no scheduled run was started: 9 hours 25 minutes). What makes the rhythm dependable is a free external timer that asks GitHub for a run every 20 minutes: see [docs/EXTERNAL-TRIGGER.md](docs/EXTERNAL-TRIGGER.md), about 15 minutes of your time. It only asks; the first job still decides whether a new snapshot is due. The slow search for new pools happens in at most one run in each three-hour block of the UTC day (00:00 to 03:00, 03:00 to 06:00 and so on), the first one that finds the last snapshot saved in an earlier block; the other runs measure the pools already known. A run you start by hand with **Run workflow** collects at once; untick "force" to apply the same rules as the schedule (the 45 minutes, the 90 minutes after a failed run and the same rule for new pools, which is also what the external timer's calls get), and tick "discover" to also look for new pools.
- **Where the data lives.** The job keeps a small amount of memory in the `state` folder of the repository: the pools already known, the recorded history, the daily volume of the largest pools and the last copy of the hook registry. It saves that back to the repository with the commit message "Update snapshot state [skip ci]". The finished site is not stored in the repository; it is built fresh in every run and handed to GitHub Pages.
- **GitHub Desktop.** Because the job saves its memory to the repository about every hour, GitHub Desktop will often show Fetch origin or Pull origin. If you change a file on your computer, press Pull origin first, then Push origin.
- **Updating the repository by hand.** The `state` folder is written by the job, not by you. When you upload a newer version of this folder, upload only `state/priority.json` from it. Never replace `state/pools.json`, `state/history.json`, `state/hookless.json`, `state/registry.json` or `state/daily.json`: a copy from the folder you were given is older than the repository's own, and replacing them erases the recorded history and the pools the job has found since.
- **If a refresh fails.** The site is **not** updated. It keeps showing the last good snapshot, still dated, so nobody sees a half-finished or empty page. A run fails on purpose when too few pools could be measured, when a data service refused our requests, or when the data did not pass its checks.
- **How you find out.** Open the Actions tab. A failed run shows a red cross; click it to read which step failed and why. GitHub also sends a notification about a failed scheduled run to the person who last changed the schedule line in the workflow; check your account's notification settings for Actions.
- **Pausing.** GitHub can switch scheduled jobs off in a public repository after a long time without activity. If the runs ever stop, open the Actions tab and press **Enable workflow** on Snapshot. Check it now and then.

## Make the refresh dependable: optional, about 15 minutes

GitHub starts scheduled runs on a best-effort basis: its documentation says they can be delayed or dropped when it is busy, and here it started none for 9 hours 25 minutes (17:07 UTC on 11 November to 02:32 UTC on 12 November 2026). For a refresh you can rely on, set up the free external timer in [docs/EXTERNAL-TRIGGER.md](docs/EXTERNAL-TRIGGER.md). A small Cloudflare Worker (or, as an alternative, cron-job.org) asks GitHub for a run every 20 minutes, with a token that can only manage the Actions of this one repository. It costs nothing, and its script is in `docs/trigger-worker.js`.

The timer only asks. The first job of the workflow, "Is a new snapshot due", still decides: a call that arrives when the last snapshot is under 45 minutes old ends green in a few seconds with "Nothing to do", so the data services are asked no more often than before and the Actions list shows many short green runs. The guide says how to check that it works, how to replace the token and how to switch it off.

## What it costs

At the time of writing, GitHub Actions on standard runners and GitHub Pages are free for **public** repositories. Private repositories have monthly limits, and Pages from a private repository needs a paid plan. Check GitHub's pricing page before relying on this. GitHub Pages is for sites like this one, not for running a business or shop; if you ever add ads or sell something, check GitHub's Pages limits page (it also has a soft 100 GB per month bandwidth limit) or move to another host. The data services are used without payment or keys. A custom domain, if you want one, is the only cost, paid to your domain registrar.

## What visitors see

The full Hook Radar page: Discover, Analytics, Networks, the use-case map ("By use case"), Compare, Watchlist and, last of the tabs, Learn, project details with pools and the hook-permission decoder, the command palette (Ctrl or Cmd + K), and downloads. A line at the top states when the snapshot was taken, for example "Snapshot taken 28 Oct 2026, 14:05 UTC · refreshed every few hours". Times on pools are absolute UTC times ("measured 14:03 UTC"), not "2 minutes ago". Everything that needs a live server is switched off: the Activity view and the Refresh button are not there.

Beside 1H, 6H and 24H the page offers 7D and 30D for the largest pools only: full UTC days up to the day before the snapshot, with every total marked "at least" and a dash for a pool that has none. Figures that cover only part of the market say so ("Partial coverage · Not total Uniswap volume"). Total tracked volume of hook pools is not total Uniswap volume and not a market share. [docs/TRUTH-RULES.md](docs/TRUTH-RULES.md) lists the rules the edition keeps.

At your choice the page has no provider credit and no dialog that lists the data sources: no credit line in the footer and no button for it in the header or on a page. GeckoTerminal's terms ask for a visible credit link, and the other providers' terms must be read; you are responsible for whatever credit they require. One line in `src/edition.ts` brings the dialog and the credits back. [docs/PROVIDER-TERMS.md](docs/PROVIDER-TERMS.md) has the details.

## Other places to host it

- [GitHub Pages](docs/HOSTING-GITHUB-PAGES.md): the route above, with troubleshooting.
- [Namecheap](docs/HOSTING-NAMECHEAP.md): point a Namecheap domain at the GitHub Pages site, or upload to Namecheap shared hosting by FTPS. The shared-hosting route ships an `.htaccess` that switches compression on.
- [Vercel](docs/HOSTING-VERCEL.md) and [Cloudflare Pages](docs/HOSTING-CLOUDFLARE-PAGES.md): serve the finished site from a copy the workflow keeps on a `site` branch. Written from the providers' documentation and not tested end to end by the project.

Whichever host you use, check that it compresses `data/snapshot.json` (about 10 MB plain, about 1 MB compressed; it grows with the number of measured pools). Each hosting page has the one-line check.

## For people who work on the code

You need Node 24. In this folder:

```
npm ci
npm run test:edition     unit tests
npm run collect          collect a fresh snapshot (slow on purpose, uses the network, rewrites state/)
npm run build:static     build the site into dist/
npm run preview          look at dist/: open the address it prints, which is not necessarily 4173
```

`npm run collect` rewrites `state/` and `public/data/`. For a trial run use `node collector/run.mjs --out <folder>`, which touches neither; see [docs/COLLECTOR-NOTES.md](docs/COLLECTOR-NOTES.md), "Running it on a PC that also runs Hook Radar".

The browser tests (`npm run test:edition-browser`) run against a built site and read its folder from `RADAR_TEST_DIST`. Build one with `npm run build:static -- --outDir <folder>`, then run `RADAR_TEST_DIST=<folder> npm run test:edition-browser` (in PowerShell, set `$env:RADAR_TEST_DIST = "<folder>"` first). Without `RADAR_TEST_DIST` the command stops with a message that says so.

- `collector/` collects and assembles the data files. `state/` is its memory. `public/data/` is where every run writes the snapshot files. It is kept out of Git: the folder as delivered contains the first snapshot, so a local preview works, but a copy cloned from GitHub has none until a Snapshot run has produced it (or you run `npm run collect`).
- `src/` is the page. It is the Hook Radar interface; the edition is selected by the build flag `VITE_STATIC_EDITION=1`, which `npm run build:static` sets for you.
- `shared/` and `server/` hold only the modules the collector reuses (hook attribution and the data checks). The always-on server is not part of this folder.
- `.github/workflows/` has the Snapshot job (`snapshot.yml`), the checks that run on every push (`ci.yml`) and the optional FTPS upload (`deploy-ftp.yml`).
- `docs/trigger-worker.js` is the script of the optional external timer (see [docs/EXTERNAL-TRIGGER.md](docs/EXTERNAL-TRIGGER.md)). It runs on Cloudflare, not in the site or in the Snapshot job, and `tests/edition-trigger.test.mjs` checks it.

If something you change makes a figure look better than the data supports, it is wrong: see [docs/TRUTH-RULES.md](docs/TRUTH-RULES.md).

## Optional: link previews

The picture that appears when someone pastes the address into a chat is built from the site's public address. The Snapshot workflow works out the GitHub Pages address (and a custom domain's address) by itself, so there is nothing to do on the GitHub Pages route.

On the other routes set the repository variable `SITE_URL` (Settings, Secrets and variables, Actions, the Variables tab) to the full https address where the site is served: the Vercel or Cloudflare address, or the address of your FTPS site, for example `https://www.example.com/`. The copy the Snapshot workflow keeps on the `site` branch for Vercel and Cloudflare and the FTPS upload both read it. When you build by hand set `VITE_SITE_URL` instead. Without it the page works as usual, but a pasted link shows no picture.
