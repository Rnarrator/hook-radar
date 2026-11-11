# Hosting on Vercel

**Status.** The project's workflow deploys to GitHub Pages and has been written and checked for that. This page is written from Vercel's documentation. It has **not** been run end to end by the project, so treat the dashboard labels as a guide and expect to adjust them.

## The one thing to understand first

Vercel can build a site every time you push to a repository. That does not work for this project by itself, because **the repository does not contain the fresh data files.** They exist only inside each Snapshot run. A Vercel build of the main branch would produce the page with no snapshot behind it.

So the workflow has an optional extra: it can keep a finished copy of the site, built to work at any address, on a branch called `site`. Vercel then only has to serve that branch's files; it does not build anything.

Do the steps in README.md first: a public repository, GitHub Pages set to Source: GitHub Actions, and one green Snapshot run. The Snapshot job checks that Pages is on before it collects anything. The Snapshot workflow is still the GitHub Pages workflow: leave GitHub Pages switched on (Source: GitHub Actions), because the last job deploys to it. Vercel is a second place that serves the same files.

## Set up

1. In your repository open Settings, Secrets and variables, Actions, the **Variables** tab, and add `PUBLISH_SITE_BRANCH` with the value `true`.
2. Run **Actions, Snapshot, Run workflow**. When it finishes a branch named `site` exists. Each later run replaces that branch with a single new commit (the old one is dropped), so it does not grow your repository's history. The step is marked to continue on error: if it fails the GitHub Pages deploy is not blocked, and the step's log says why.
3. In Vercel choose Add New, Project, and import the repository.
4. On the import screen set Framework Preset: **Other**. Leave the Build Command empty (turn its override on and leave it blank). Set the Output Directory to `.` (override on). If the dashboard does not accept `.`, leave the field empty: the `site` branch has `index.html` at its top level. Press **Deploy**.
5. **Ignore that first deployment.** A new Vercel project takes `main` as its production branch, and `main` holds the unbuilt source, not the finished site, so the first deployment is a blank or broken page. This is expected.
6. In the project open **Settings, Environments, Production, Branch Tracking**, change the branch to `site` and Save. Pushes to other branches then only create previews. Saving does not redeploy anything by itself.
7. Make `site` go live now. Optional first: for the picture that appears when someone pastes the address into a chat, add the repository variable `SITE_URL` (the same Variables tab) with the full https address of your Vercel site, for example `https://YOUR-PROJECT.vercel.app/`. It must be the Vercel address, because the picture's link is built from it; the copy on the `site` branch reads it. It must start with `https://`: if it does not, the run still updates the `site` branch but leaves the picture out, and shows a warning that names `SITE_URL` on the run's summary page. Then run **Actions, Snapshot, Run workflow** again: the new `site` branch it pushes starts a production deployment. (Or, in Vercel, open Deployments, Create Deployment and enter the branch `site`; that deployment lacks the picture until the next Snapshot run.) Otherwise the right site appears with the next collecting run, up to about an hour later (longer if GitHub starts it late). After that, every Snapshot run that updates the `site` branch makes Vercel publish the new files.

## Compression

`data/snapshot.json` is about 10 MB as plain JSON (measured on a recent real snapshot) and about 1 MB once compressed with gzip; it grows with the number of measured pools. The host has to send it compressed, or every visit downloads the whole 10 MB.

Vercel's documentation lists `application/json` among the file types its CDN compresses (gzip or Brotli, whichever the browser accepts), with no setting to change. The project has not seen this on a live Vercel site of its own, so verify yours once it is live:

```
curl -H "Accept-Encoding: gzip" -I https://YOUR-PROJECT.vercel.app/data/snapshot.json
```

The reply should contain `Content-Encoding: gzip` (or `br`). If it does not, ask Vercel's support or check their compression documentation for a change.

## Things that may go wrong

- **Vercel does not deploy the bot's commit.** The commit on `site` is authored by `github-actions[bot]`. Some Vercel plans refuse to deploy a commit whose author is not a team member. This is most likely if the repository is private; keep it public (the workflow needs a public repository on a free GitHub plan anyway). If your deployments show as blocked or skipped, check the project's Git settings and Vercel's current rules on commit authors. The project has not tested this.
- **Personal use.** Vercel's free Hobby plan is meant for personal, non-commercial use. Read its current terms against what you plan to do.
- **Limits.** Build and bandwidth limits change; check the pricing page.
- **A blank page.** The copy on the `site` branch uses relative paths. If you set `VITE_BASE` yourself somewhere, remove it.

## Custom domain

Add the domain in the Vercel project (Settings, Domains) and follow the DNS records Vercel shows. For a Namecheap domain, the records are added in Namecheap's Advanced DNS tab as described in [HOSTING-NAMECHEAP.md](HOSTING-NAMECHEAP.md), but with the values Vercel gives you, not GitHub's.
