# Make the refresh dependable: a free external timer

**What to do**

- This is optional, free and takes about 15 minutes. Without it the site still refreshes by itself, about every hour when GitHub starts its scheduled runs. With it, a small timer outside GitHub also asks GitHub for a run every 20 minutes, so a start that GitHub drops is made up within 20 minutes instead of hours.
- You make a limited access token on GitHub, a free Worker on Cloudflare that holds the token and the timer, and then look at the Actions tab to see it work. The recommended route is Route A (Cloudflare). Route B (cron-job.org) does the same with a different free service.
- Route A sends no alert when it stops, for example when its token runs out. Put the monthly check of "Check it once a month" in your calendar when you set it up. Route B can e-mail you when a call fails (Route B, step 7).

## Why this exists

GitHub starts the scheduled runs of a workflow on a best-effort basis. Its documentation says that a scheduled run can be delayed when many workflows are running and that some queued runs may be dropped when the load is high. It has happened here: GitHub started no scheduled run between 17:07 UTC on 11 November and 02:32 UTC on 12 November 2026, a gap of 9 hours 25 minutes (the only run in between, at 21:42, was started by hand), although the workflow asks for three starts an hour. Nothing broke: the site kept its last snapshot, still dated. But the data was hours older than the hour the site aims for, and "about every hour" cannot be promised by GitHub's schedule alone.

A timer that lives outside GitHub does not depend on GitHub's scheduler. If one of its calls gets no answer, the next one arrives 20 minutes later.

## What the timer does, and what it does not do

- **It only asks.** Every 20 minutes it sends one request to GitHub: "start the Snapshot workflow, as if on schedule". The request sets the two boxes you see when you press **Run workflow**, `force` and `discover`, both to `"false"`. That is what tells the workflow to treat the call like a scheduled run.
- **The first job decides.** The workflow's first job, "Is a new snapshot due", looks at when the last snapshot was saved. When it is under 45 minutes old, the run ends green in a few seconds with the words "Nothing to do" in its summary, publishes nothing and asks no data service anything. When it is 45 minutes old or more, the run collects, exactly as a scheduled run would. A run is still held back for 90 minutes after one that failed, and the slow search for new pools still happens in at most one run in each three-hour block of the UTC day. A run counts as failed when any of its jobs failed, the first job included: one passing hiccup there (a download that fails while the job is being set up, say) can hold collecting back for up to 90 minutes, and every call in that time says "the last run failed N minutes ago". The timer makes about twice as many first jobs a day as the schedule alone, and it does not shorten that wait.
- **It does not make the site refresh faster.** A new snapshot is never taken less than 45 minutes after the last one was saved (unless you press **Run workflow** yourself and leave **force** ticked), so the data services see the same traffic as before, and the rhythm stays about an hour. What the timer adds is that someone is always there to ask when the time has come.
- **GitHub's own schedule stays.** The three scheduled starts in the workflow (at 7, 27 and 47 minutes past, UTC) are not touched. The two work side by side: whichever asks first when a snapshot is due makes the run, and the other finds the new snapshot and stops.
- **It cannot change your site or your code.** The token you make can only manage the Actions of this one repository. It cannot read or change the code, the settings or the secrets. See "What it costs, and what it can reach".
- **It does not fix a collection that fails.** When the collector refuses to publish (too few pools measured, a provider refused our requests), the run fails, nothing is published and the site keeps its last snapshot, as before. The timer only starts runs.
- **It cannot help when GitHub itself is not running workflows.** Then the site keeps its last snapshot, dated, until GitHub is back.
- **It does not tell you when it stops.** Route A as set up here sends no alert. If its token expires or is deleted, or its trigger is removed, the calls fail or stop without a word, and the site falls back to GitHub's own schedule, which is the best-effort start this guide is meant to improve on. Route B can e-mail you when a call fails. For Route A, make the monthly check of "Check it once a month".

The rules above are tested in this repository with a stand-in clock and a stand-in for GitHub (`tests/edition-gate.test.mjs`). On GitHub itself only scheduled runs have been seen stopping at "Nothing to do" so far (two, on 12 November 2026), and a call with `force` set to `"false"` has not been seen there. The first real call from your timer is the first time such a call is handled on GitHub itself, so look at the first few runs (see "How to check that it works").

## What it costs, and what it can reach

- **Cost: nothing.** The figures below are what the providers' documentation said when this was written; check them if it matters to you. GitHub says the standard runners are free in public repositories, and the first job of a run that stops at "Nothing to do" takes seconds. Cloudflare's free Workers plan allows 5 Cron Triggers per account and 100,000 requests a day, and this uses one Cron Trigger and 72 calls a day. cron-job.org says it is free.
- **GitHub's limits are far away.** A personal token may make 5,000 requests an hour. The timer makes 3.
- **What the token can do.** It is a fine-grained token limited to this one repository, and the only permission you give it is **Actions**, set to **Read and write**. With that it can start, cancel and delete workflow runs of this repository and switch its workflows on and off. It can also start any workflow of the repository that has a manual trigger, not only this one: it can start Snapshot with **force** and **discover** both ticked, which collects at once and sends about 60 extra requests to the v4.xyz indexer, and it can start the optional `deploy-ftp.yml` workflow if you use it. The workflow's one-run-at-a-time rule keeps that to one run at a time, but it is still real traffic to the data services. It cannot read or change the code, the settings or the secrets. If GitHub shows a read-only **Metadata** permission beside it, leave that as it is.
- **Where the token lives.** In Route A it is stored as a Cloudflare Worker secret: Cloudflare does not show it again after you save it. It is never written in this repository, and the Worker never logs it. Do not paste it into a file of the repository, an issue, a chat or a screenshot.
- **What the Actions tab looks like afterwards.** It gets longer: the timer adds up to 72 short runs a day, on top of the scheduled ones. They are marked as started manually (the event `workflow_dispatch`). While a collection is running, a newer call waits its turn, and GitHub keeps only the newest waiting run, cancelling the older waiting one. A grey "cancelled" entry in the list is that: a waiting run that never started. For the timer's calls it is harmless. If your own **Run workflow** shows "cancelled", a newer call took its place while a collection was running: wait for that collection to finish, then press **Run workflow** again.

## Before you start

- The Snapshot workflow has run green at least once (see the start guide: "Run the Snapshot job once"), and the repository change that came with this guide is on GitHub (in GitHub Desktop: press **Push origin**). Without it, a call with `force` set to `"false"` would never look for new pools. To check, open Actions, Snapshot, **Run workflow**: the box named **force** should say "Untick it to be treated like a scheduled run".
- If you are holding back collection until the v4.xyz maintainers have answered (see [PROVIDER-TERMS.md](PROVIDER-TERMS.md) item 1), make that one-line edit first. The timer asks for the same runs the schedule asks for; it does not change what they do.
- You have a GitHub account that owns the repository, and an e-mail address for a free Cloudflare account. You need about 15 minutes, and a place to keep the token open for a few minutes while you copy it (the browser page is enough).

## Route A (recommended): a Cloudflare Worker

Menu names below are as the providers' documentation gave them at the time of writing. If one has moved, the words are usually still easy to find.

### 1. Make the token on GitHub

1. On github.com, click your profile picture at the top right, then **Settings**.
2. In the left column choose **Developer settings**, then, under **Personal access tokens**, **Fine-grained tokens**, then press **Generate new token**.
3. **Token name:** `Hook Radar timer`. **Description** (optional): `Asks GitHub to run Snapshot every 20 minutes`.
4. **Expiration:** GitHub's default is 30 days, which would stop the timer after a month. Choose a custom date about a year ahead (the longest GitHub offers you, if that is less) and put a reminder in your calendar for a week before it. See "Rotate or revoke the token".
5. **Resource owner:** your own account.
6. **Repository access:** choose **Only select repositories** and pick `hook-radar` (your repository) in the list. Nothing else.
7. **Permissions:** open **Repository permissions**, find **Actions** and set it to **Read and write**. Leave every other permission at "No access".
8. Press **Generate token**. GitHub shows the token once. Copy it and keep that page open until you have finished step 4 below. If you lose it, make a new one.

### 2. Create the Worker on Cloudflare

1. Go to dash.cloudflare.com and sign up (it is free) or log in.
2. Open **Workers & Pages** and press **Create application**. Choose a simple starter from the gallery of templates (the plain "Hello World" one if it is there: you replace its code in the next step), name it `hook-radar-timer` and press **Deploy**.

### 3. Paste the code

Open the new Worker from **Workers & Pages** and look for the button that opens its code editor (for example **Edit code**; Cloudflare's own documentation calls it the quick editor in the Workers dashboard). Select everything in the editor, delete it, paste the whole script below, and press **Deploy**.

The same script is in the file `docs/trigger-worker.js` of this folder. If your repository has another name than `Rnarrator/hook-radar`, or its default branch is not `main`, change the first lines.

```js
// Hook Radar timer: a Cloudflare Worker that asks GitHub to start the Snapshot
// workflow every 20 minutes. It only asks. The first job of the workflow ("Is a
// new snapshot due") decides whether anything is collected: with force and
// discover both "false", a call is treated exactly like a scheduled run, so a call
// that arrives when the last snapshot is under 45 minutes old ends green in a few
// seconds with "Nothing to do" and contacts no data service.
// Guide: docs/EXTERNAL-TRIGGER.md.
//
// It needs one secret, named HOOK_RADAR_DISPATCH_TOKEN: a fine-grained GitHub
// token limited to this one repository, with only the Actions permission set to
// Read and write. The token is never written in this file and never logged.

const REPOSITORY = "Rnarrator/hook-radar"; // owner/name of your repository
const WORKFLOW_FILE = "snapshot.yml";
const BRANCH = "main";
const API_VERSION = "2022-11-28"; // GitHub's API version, see the guide

const ENDPOINT = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
// Both inputs are "false" on purpose: the workflow then decides by its own rules.
// Leave them out and GitHub fills in force = true, which collects at every call.
const BODY = JSON.stringify({
  ref: BRANCH,
  inputs: { force: "false", discover: "false" },
});

export default {
  // Runs on the Cron Trigger (*/20 * * * *, UTC).
  async scheduled(controller, env, ctx) {
    await askGitHub(env);
  },

  // A visit to the Worker's own address shows this line and does nothing else.
  async fetch() {
    return new Response(
      "Hook Radar timer. This Worker only acts on its Cron Trigger.\n",
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  },
};

async function askGitHub(env) {
  const token =
    typeof env.HOOK_RADAR_DISPATCH_TOKEN === "string"
      ? env.HOOK_RADAR_DISPATCH_TOKEN.trim()
      : "";
  if (!token) {
    throw new Error(
      "The secret HOOK_RADAR_DISPATCH_TOKEN is not set, so GitHub was not asked.",
    );
  }
  // Never let the token reach a log, whatever GitHub or the network says.
  const safe = (text) => String(text).split(token).join("[token]");

  console.log(`Asking GitHub to run ${WORKFLOW_FILE} in ${REPOSITORY}.`);
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "hook-radar-timer (Cloudflare Worker)",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: BODY,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(
      safe(`GitHub could not be reached: ${error?.name}: ${error?.message}`),
    );
  }

  console.log(`GitHub answered HTTP ${response.status}.`);
  if (response.ok) return; // any 2xx: the run was accepted

  // GitHub's own words say what is wrong (for example "Bad credentials").
  const reason = safe(await response.text().catch(() => "")).slice(0, 300);
  throw new Error(
    `GitHub refused the request: HTTP ${response.status} ${reason}`,
  );
}
```

What it does, in words: when the Cron Trigger fires it sends this one request, `POST /repos/Rnarrator/hook-radar/actions/workflows/snapshot.yml/dispatches` to `api.github.com`, with the body `{"ref":"main","inputs":{"force":"false","discover":"false"}}`. It writes the answer's number ("GitHub answered HTTP 200.", or another 2xx) to Cloudflare's log. It stops with an error, visible in the log, when GitHub refuses the request or cannot be reached. It never writes the token anywhere.

The two lines `force` and `discover` matter. If they are missing, GitHub fills in the workflow's defaults, and the default of `force` is "true": every call would then collect, three times an hour, and the data services would be asked three times as often as intended. Do not delete them.

### 4. Add the token as a secret

1. Open **Workers & Pages**, select the Worker, then **Settings**.
2. Under **Variables and Secrets** press **Add**.
3. Set the type to **Secret**. **Variable name:** `HOOK_RADAR_DISPATCH_TOKEN`, written exactly like that. **Value:** paste the token from step 1.
4. Press **Deploy**.

Cloudflare does not show a secret again after you have saved it. Close the GitHub page that showed the token.

### 5. Set the timer

1. In the same Worker, open **Settings**, then **Triggers**, then **Cron Triggers**, and press **Add**.
2. Enter the cron expression `*/20 * * * *` and save it. It means every 20 minutes, at 00, 20 and 40 minutes past each hour. Cloudflare runs Cron Triggers on UTC time.

Cloudflare says a new or changed trigger may take several minutes, up to 15, to reach its network, so the first call can be late.

### 6. Check that it works

See "How to check that it works" below.

## Route B (alternative): cron-job.org

Use this if you cannot find your way around Cloudflare. It does the same thing with a free service that calls a web address on a timetable. The difference is where the token is kept: cron-job.org holds it inside the job in your account there, where anyone who can sign in to that account can read it. Use a long password there. The token can only manage the Actions of this one repository.

1. Make the token as in Route A, step 1.
2. Sign up at cron-job.org (it says it is free) and sign in. Create a new cron job.
3. **Title:** `Hook Radar timer`. **Address (URL):** `https://api.github.com/repos/Rnarrator/hook-radar/actions/workflows/snapshot.yml/dispatches`
4. **Schedule:** every 20 minutes, that is at minutes 0, 20 and 40 of each hour (UTC if their form asks for a time zone).
5. In the advanced settings of the job set the **request method** to **POST**, and add these **headers** (one name and value each):
   - `Authorization` with the value `Bearer YOUR_TOKEN` (the word Bearer, a space, then the token from step 1)
   - `Accept` with the value `application/vnd.github+json`
   - `X-GitHub-Api-Version` with the value `2022-11-28`
   - `Content-Type` with the value `application/json`
   - `User-Agent` with the value `hook-radar-timer` (GitHub refuses requests that carry none; if their form does not let you set it, leave it out, because cron-job.org sends its own)
6. Set the **request body** to exactly this line:
   `{"ref":"main","inputs":{"force":"false","discover":"false"}}`
7. In the notification settings, ask to be told when the job fails. Save the job.

The wording of cron-job.org's form may differ from the words above; the things to set are the address, every 20 minutes, POST, the five headers and the body. Their job history shows each call and the answer GitHub gave: a status in the 200s means GitHub accepted it. Then see "How to check that it works".

## How to check that it works

1. On github.com open your repository, then **Actions**, then **Snapshot** in the list on the left. Cloudflare can take up to 15 minutes to start a new timer. After that, a new run appears three times an hour, at about 00, 20 and 40 minutes past each hour, UTC.
2. Most of them show a green tick after seconds. Open one and look at the summary of its first job, "Is a new snapshot due": it says, for example, "Nothing to do: the last snapshot is 12 minutes old (a new one is collected from 45 minutes)". Once about an hour, a run says "Collecting:" instead, goes on to the other two jobs and takes about 15 minutes, which is the normal refresh.
3. To see only the timer's calls, use the **Event** filter above the list and choose `workflow_dispatch`.
4. On Cloudflare, open the Worker, then **Settings**, **Trigger Events**, **View events**. It lists the last 100 calls of the Cron Trigger, and each one should have succeeded. The log lines themselves ("GitHub answered HTTP 200.", any number in the 200s is fine) are under **Observability**, **Logs** of the Worker. Cloudflare's documentation says its free plan keeps Workers Logs for 3 days and that its list of past Cron events can take up to 30 minutes to show a call. These are Cloudflare's menu names at the time of writing; if one has moved, the words are usually still easy to find.

If nothing appears after about 40 minutes, see "If it stops working".

## Check it once a month

Route A sends no alert. If its token expires, is deleted or loses its permission, or if the trigger is removed, the calls fail or stop and nothing tells you. The site then falls back to GitHub's own schedule, the best-effort start this guide is meant to improve on. A token that expires after a year stops the timer in just this way, and Cloudflare keeps its logs for only 3 days on the free plan, so the log will not still hold the first failure when you look. Put this check in your calendar once a month, next to the reminder for a week before the token's expiry date (see "Rotate or revoke the token"). It takes two minutes:

1. On github.com open your repository, then **Actions**, then **Snapshot**. Use the **Event** filter above the list and choose `workflow_dispatch`. The timer makes three runs an hour, so about three should be less than an hour old, and the newest should be well under an hour old. A run you started yourself with **Run workflow** is listed here too: do not mistake it for the timer's.
2. If the list is short or stale, open the Worker on Cloudflare, **Settings**, **Trigger Events**, **View events**: a call that GitHub refused shows there as a failure.
3. Open your token's page on GitHub (profile picture, **Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**) and read its expiry date.

A list that is short or stale, or a failure in step 2, means "If it stops working" below.

## Rotate or revoke the token

The token is the one secret in this setup. Replace it before its expiry date (the reminder you set, and the monthly check), whenever you think someone else may have seen it, or when Cloudflare's Trigger Events or the Worker's log show HTTP 401. In Route A nothing warns you when it expires, so do not wait for a sign.

**Rotate** (about 5 minutes; a call that arrives while the secret is being replaced is simply refused, which does no harm):

1. Make a new token as in Route A, step 1, with a different name, for example `Hook Radar timer 2`.
2. On Cloudflare open the Worker, **Settings**, **Variables and Secrets**, and delete the old `HOOK_RADAR_DISPATCH_TOKEN`. Then press **Add** and add it again with the same name and the new token, as in Route A, step 4, and press **Deploy**. (Cloudflare's documentation describes the dashboard only for adding and deleting a secret.) For Route B, change the value of the `Authorization` header in the job.
3. Wait for the next call and check the Actions tab shows it.
4. Delete the old token on GitHub: profile picture, **Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**, then **Delete** to the right of the old one.

**Revoke at once** (a leak): do step 4 first. Delete the token on GitHub. The timer's calls are then refused (HTTP 401) and do nothing, which is safe. Then open **Actions** and look for runs you did not expect: with this token someone could have started Snapshot with **force** and **discover** ticked (a run that collects at once and publishes), or another workflow of the repository that has a manual trigger. Cancel any you find. Make a new token when you are ready.

## Switch it off

- **For a while:** on Cloudflare open the Worker, **Settings**, **Triggers**, **Cron Triggers**, and remove the `*/20 * * * *` trigger. In Route B, disable the cron job. GitHub's own schedule goes on as before.
- **For good:** also delete the Worker, and delete the token on GitHub (see "Rotate or revoke the token").
- **If a provider asks you to stop** (see [PROVIDER-TERMS.md](PROVIDER-TERMS.md)): disable the Snapshot workflow as that page says, and switch the timer off as above, so that nothing is left running unattended.

## If it stops working

Start with the Actions tab: are runs from the timer still appearing, and what does the summary of the newest one say? Then, on Cloudflare, open the Worker, **Settings**, **Trigger Events**, **View events** to see whether the calls are made and which failed, and read the Worker's log (**Observability**, **Logs**): GitHub's own words are in it.

| What you see                                                                          | What it usually means, and what to do                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No runs from the timer in the Actions tab, 40 minutes after setting it up             | The trigger is not set or is not saved (Route A, step 5), or Cloudflare is still passing it on (it can take up to 15 minutes). Look at the Worker's log on Cloudflare.                                                                                                                 |
| The log says the secret `HOOK_RADAR_DISPATCH_TOKEN` is not set                        | The secret is missing, is named differently or was not deployed. Add it as in Route A, step 4, exactly as written, and press **Deploy**.                                                                                                                                               |
| HTTP 401, "Bad credentials"                                                           | The token is wrong, has expired or was deleted. Make a new one and replace it ("Rotate").                                                                                                                                                                                              |
| HTTP 403 or 404, "Resource not accessible", "Not Found"                               | The token does not cover this repository or its Actions permission is not **Read and write**, or the repository name or file name in the script is wrong. Open the token's page on GitHub and compare it with Route A, step 1. A 403 can also say that a rate limit was reached: wait. |
| HTTP 422                                                                              | GitHub refused the request itself, and its message says why (a branch that does not exist, a workflow without the dispatch trigger, an input it does not know). Compare the first lines of the script with the workflow file. Also check that the Snapshot workflow is not disabled.   |
| The log says HTTP 200, but no run appears                                             | Check the Actions tab's filters, then look at githubstatus.com: GitHub may be having trouble with Actions.                                                                                                                                                                             |
| Runs appear, all say "Nothing to do", but the site is old                             | Read the words after "Nothing to do". "The last run failed N minutes ago" means a collection failed and is held back for 90 minutes: see "How you find out" in the start guide. A failing collection is not the timer's doing.                                                         |
| Every run from the timer collects, three times an hour, and the data services get hit | The two lines `force` and `discover` are missing or not `"false"` in the script. Restore them at once, or switch the timer off.                                                                                                                                                        |
| It worked for a long time, then every call is refused                                 | GitHub says it supports the API version in the script (`2022-11-28`) until 10 March 2028 at least. After that, replace the version in the script with a newer one from GitHub's page on API versions.                                                                                  |

A timer that stops does no harm: the three scheduled starts in the workflow go on as before, and the site keeps its last snapshot, dated, whatever happens.
