# Namecheap: a custom domain, or shared hosting

There are two different things you might mean by "host it on Namecheap".

- **A. You bought a domain at Namecheap and want it to open the site that GitHub Pages serves.** This is the simple, recommended route. Namecheap only holds the name; GitHub serves the files and keeps them fresh.
- **B. You have Namecheap shared hosting (cPanel) and want the files to live there.** The optional FTPS workflow uploads each new build.

## A. Point a Namecheap domain at GitHub Pages

GitHub's own instructions for custom domains are the authority if anything below differs from what you see; the DNS values here are the ones GitHub documents at the time of writing.

1. **Choose the name.** `www.example.com` is the easiest. An apex name (`example.com` with nothing before it) also works.
2. **Tell the repository.** On github.com open your repository, press **Add file**, **Create new file**, type `public/CNAME` as the name (exactly these letters, capitals included, no `.txt`), type your domain on one line (for example `www.example.com`) and press **Commit changes**. Do not make this file in Notepad or File Explorer on Windows: they quietly name it `CNAME.txt`, which the Snapshot job does not read. The Snapshot workflow looks for this file; without it the page is built for the wrong address and shows blank. (If it finds a `CNAME.txt` or a `cname` and no `public/CNAME`, the Snapshot run stops with a message naming the file.)
3. **Tell GitHub Pages.** Settings, Pages, "Custom domain": type the same name and Save. Run **Snapshot** again so the page is rebuilt with the new address.
4. **Open Namecheap.** Domain List, Manage next to the domain, then **Advanced DNS**. The "Nameservers" setting on the Domain tab must be "Namecheap BasicDNS" (or PremiumDNS) or the records below are ignored.
5. **Remove the parking records.** Delete the default `www` CNAME pointing at `parkingpage.namecheap.com` and the default URL Redirect record, if present.
6. **Add the records.**

   For `www.example.com`:

   | Type         | Host  | Value                |
   | ------------ | ----- | -------------------- |
   | CNAME Record | `www` | `USERNAME.github.io` |

   For an apex name `example.com`, add four A records, all with Host `@`:

   | Type     | Host | Value             |
   | -------- | ---- | ----------------- |
   | A Record | `@`  | `185.199.108.153` |
   | A Record | `@`  | `185.199.109.153` |
   | A Record | `@`  | `185.199.110.153` |
   | A Record | `@`  | `185.199.111.153` |

   Optionally also four AAAA records for IPv6, Host `@`: `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`. To make both `example.com` and `www.example.com` work, add the `www` CNAME as well and set the one you chose in Pages as the custom domain; GitHub redirects the other.

7. **Wait.** DNS changes take from a few minutes to some hours. Settings, Pages shows "DNS check successful" when it is ready.
8. **Tick "Enforce HTTPS"** in Settings, Pages once it becomes available. GitHub issues the certificate itself; this can take a while after the DNS check passes.
9. Optional but sensible: in your account settings under Pages, **verify the domain** with the TXT record GitHub shows. It stops someone else claiming your domain on their own GitHub Pages site.

Do not point a wildcard (`*`) record at GitHub Pages.

With this route GitHub serves the files and compresses them, so there is nothing to set up on Namecheap. See "Compression" in [HOSTING-GITHUB-PAGES.md](HOSTING-GITHUB-PAGES.md) for the check to run against your own address.

## B. Upload to Namecheap shared hosting by FTPS

Use this only if you want the files on your own Namecheap hosting. It is an **alternative** to the GitHub Pages deploy, not an addition. `deploy-ftp.yml` collects, builds, saves state and uploads, all by itself. If both it and the Snapshot workflow are active, every data service is asked twice.

The page is built with a relative base, so it works at the root of your domain or in any sub-folder, and needs no rewrite rules.

1. **Make a dedicated FTP account.** In cPanel, FTP Accounts, create an account whose directory is the folder you will publish to (for example `public_html/radar`, or `public_html` for the main site). A dedicated account limits the damage if the password leaks. Step 4 then needs `FTP_SERVER_DIR` set to `./`.
2. **Find the server name.** In cPanel, FTP Accounts, "Configure FTP Client" for that account. Use the **server host name** shown there. The TLS certificate belongs to that name, not to your own domain; connecting through your own domain may fail the certificate check. The workflow checks the certificate (`security: strict` in `deploy-ftp.yml`), so that your password is only ever sent to the server you named. The action's own default is to skip that check; this workflow deliberately does not. If the upload fails with a certificate error, first make sure `FTP_SERVER` holds the host name from cPanel. Only as a last resort, and only if you accept that the server is no longer verified, edit `deploy-ftp.yml` and change `security: strict` to `security: loose`.
3. **Add three repository secrets.** Settings, Secrets and variables, Actions, New repository secret: `FTP_SERVER` (the host name), `FTP_USERNAME` and `FTP_PASSWORD`. Never put them in a file in the repository.
4. **Add the variables** (the Variables tab next to Secrets). `ENABLE_FTP_DEPLOY` with the value `true`: until then the job is skipped. `FTP_SERVER_DIR`: the folder on the server relative to the FTP account's own directory, ending with `/`. If you made the dedicated account in step 1 (its directory is already the folder you publish to), set it to `./`; this is required for that route. The default `public_html/` only fits the cPanel main account, which logs in at the home folder. If you leave `FTP_SERVER_DIR` unset on the dedicated account, the files land one level too deep (for example `public_html/radar/public_html/`). Optional: `SITE_URL`, the public address of the site, for share cards.
5. **Turn the Snapshot workflow off** (Actions, Snapshot, the three dots, Disable workflow), unless you also want the GitHub Pages copy kept fresh and accept the doubled requests.
6. **Test with a dry run.** Actions, "Deploy to Namecheap by FTPS", Run workflow, leave "Dry run" ticked. Only the final upload step is dry: it only lists what it would upload. The run still collects the snapshot, which asks the data services, builds the site, and saves `state/` to the repository in a bot commit when it changed. The server directory in the log must be the folder where `index.html` should appear (the folder your domain shows); if the paths are one level too deep, correct `FTP_SERVER_DIR` (step 4). Then run it again with the tick removed.
7. **Automatic refreshes.** Open `.github/workflows/deploy-ftp.yml` on github.com (open the file, then the pencil icon), or in any text editor and commit with GitHub Desktop. Delete just the `#` at the start of the two lines `  #schedule:` and `  #  - cron: "47 */3 * * *"`, nothing else, and commit. They then read like this, `schedule:` lined up under `workflow_dispatch:`:

   ```text
     schedule:
       - cron: "47 */3 * * *"
   ```

   This workflow keeps the three-hour schedule above and has no "Is a new snapshot due" check. The history chart on the page draws a break between two points more than three hours apart, so on this schedule a run that starts a little late leaves a break in the line. The page also says its snapshot is old once it is more than four hours old, so a run that GitHub starts more than about an hour late makes the page say so. The GitHub Pages route, which collects about once an hour, does not.

   If GitHub Desktop says there are newer commits to pull, press Pull origin first, then Push origin: the "Deploy to Namecheap by FTPS" workflow saves its memory (the `state` folder) to the repository every few hours.

What it does on the server: it uploads only what changed since its last run, and keeps a small record file on the server of what it uploaded. It removes only files it uploaded earlier. Other files in the folder, ones it never uploaded, are left alone. One exception matters, see the next section: the site ships its own `.htaccess`, so an `.htaccess` that already sits in that same folder is replaced by the first upload.

### Compression and the `.htaccess` file

`data/snapshot.json` is about 10 MB as plain JSON (measured on a recent real snapshot) and about 1 MB compressed with gzip; it grows with the number of measured pools. Shared hosting does not always compress JSON, and then every visit downloads the whole 10 MB.

So the build writes a small `.htaccess` file next to `index.html`, and the FTPS workflow uploads it with the rest of the site. On an Apache server such as cPanel hosting it does two things:

- asks the server to compress JSON, CSS, JavaScript, SVG and HTML answers (`AddOutputFilterByType DEFLATE ...`);
- tells browsers to check the `.json` data files again before reusing a stored copy (`Cache-Control: no-cache`), because they are renewed every few hours. An unchanged file is answered with a short "not modified" reply, not another download.

Other hosts ignore the file. This is what the build writes:

```apache
# Hook Radar, Auto Snapshot edition. Written by the build for Apache hosts
# (cPanel shared hosting). Other hosts ignore this file.

# Compress text answers; the data file is about ten times smaller that way.
<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE application/json text/css application/javascript text/javascript image/svg+xml text/html text/plain application/manifest+json
</IfModule>

# The data files are renewed every few hours: have the browser ask again before
# it reuses a stored copy. An unchanged file is answered with a short 304.
<IfModule mod_headers.c>
  <FilesMatch "\.json$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
</IfModule>
```

It is written by the build, not kept in the repository's `public` folder. To use your own rules instead, save them, with the lines above, in a file named `.htaccess` in the `public` folder; the build then leaves your file alone.

**Before the first upload.** If the folder you publish to already has an `.htaccess` (a WordPress site, a redirect to HTTPS, a PHP version setting), the first upload replaces it. Either publish into a folder of its own (for example `public_html/radar`, as in step 1, and set `FTP_SERVER_DIR` to `./`), or put the lines you need from your existing file into `public/.htaccess` first, together with the lines above. The dry run in step 6 lists `.htaccess` among the files, so you can see it coming.

**Check that compression works** once the site is uploaded:

```
curl -H "Accept-Encoding: gzip" -I https://YOUR-SITE/data/snapshot.json
```

The reply should contain `Content-Encoding: gzip`. If it does not, the server is not reading the file or has compression switched off. Look for an "Optimize Website" or similar compression page in cPanel, or ask Namecheap support to enable `mod_deflate` for the account. The page works without compression, only slowly.

Things to know:

- Shared hosting varies. If the upload fails with a login or TLS error, the message in the step log is the thing to look up in Namecheap's cPanel documentation. A certificate error usually means `FTP_SERVER` is not the host name cPanel shows (see step 2).
- This route was written from the action's documentation and the project has not run it against a Namecheap account.
