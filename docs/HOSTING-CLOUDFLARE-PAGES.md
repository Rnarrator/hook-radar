# Hosting on Cloudflare Pages

**Status.** The project's workflow deploys to GitHub Pages and has been written and checked for that. This page is written from Cloudflare's documentation. It has **not** been run end to end by the project; treat the dashboard labels as a guide.

## The one thing to understand first

Cloudflare Pages can build a site whenever you push to a repository. That does not work for this project by itself, because **the repository does not contain the fresh data files.** They exist only inside each Snapshot run. A Cloudflare build of the main branch would produce the page without a snapshot.

So the workflow has an optional extra: it can keep a finished copy of the site, built to work at any address, on a branch called `site`. Cloudflare then only serves that branch; it builds nothing.

Do the steps in README.md first: a public repository, GitHub Pages set to Source: GitHub Actions, and one green Snapshot run. The Snapshot job checks that Pages is on before it collects anything. The Snapshot workflow is still the GitHub Pages workflow: leave GitHub Pages switched on (Source: GitHub Actions), because the last job deploys to it. Cloudflare is a second place that serves the same files.

## Set up

1. In your repository open Settings, Secrets and variables, Actions, the **Variables** tab, and add `PUBLISH_SITE_BRANCH` with the value `true`.
2. Run **Actions, Snapshot, Run workflow**. When it finishes, a branch named `site` exists. Each later run replaces it with a single new commit, so your repository's history does not grow with it. The step continues on error: if it fails the GitHub Pages deploy is not blocked, and the step's log says why.
3. In the Cloudflare dashboard open Workers and Pages, create a project, and choose **Connect to Git**. Select the repository.
4. Set the **Production branch** to `site`.
5. Framework preset: **None**. Leave the **Build command** empty. Set the **Build output directory** to `/` (the top of the branch). If the form insists on a build command, use one that does nothing, for example `exit 0`.
6. Save and deploy. Every Snapshot run that updates the `site` branch makes Cloudflare publish the new files.
7. Optional, for the picture that appears when someone pastes the address into a chat: add the repository variable `SITE_URL` (the same Variables tab as in step 1) with the full https address of your Cloudflare site, for example `https://YOUR-PROJECT.pages.dev/`, then run **Actions, Snapshot, Run workflow** again. It must be the Cloudflare address, because the picture's link is built from it; the copy on the `site` branch reads it. It must start with `https://`: if it does not, the run still updates the `site` branch but leaves the picture out, and shows a warning that names `SITE_URL` on the run's summary page.

## Compression

`data/snapshot.json` is about 10 MB as plain JSON (measured on a recent real snapshot) and about 1 MB once compressed with gzip; it grows with the number of measured pools. The host has to send it compressed, or every visit downloads the whole 10 MB.

Cloudflare's documentation says its network compresses `application/json` (and CSS, JavaScript and SVG) with gzip or Brotli when the visitor's browser accepts it, with no setting to change. On 28 October 2026 a public site served through Cloudflare answered a JSON file with `Content-Encoding: gzip`. The project has not run this site on Cloudflare Pages itself, so verify yours once it is live:

```
curl -H "Accept-Encoding: gzip" -I https://YOUR-PROJECT.pages.dev/data/snapshot.json
```

The reply should contain `Content-Encoding: gzip` (or `br`). If it does not, look at Cloudflare's compression settings for the domain, or ask Cloudflare's support.

## Limits to check

- Cloudflare's free plan limits the number of builds per month. At eight refreshes a day the workflow causes about 240 a month. Check the current limit on Cloudflare's pricing page.
- Cloudflare Pages allows 25 MiB per file; `snapshot.json` is about 10 MB today and could reach about 21 MB if far more pools get priced, so watch its size.
- Cloudflare may treat commits by `github-actions[bot]` like any other. The project has not tested it.

## Custom domain

Add it under the project's Custom domains tab and follow the DNS records Cloudflare shows. If the domain is registered at Namecheap but you want Cloudflare to answer for it, Cloudflare asks you to change the nameservers at Namecheap to the two it gives you. This is different from the records in [HOSTING-NAMECHEAP.md](HOSTING-NAMECHEAP.md), which are for GitHub Pages.
