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
