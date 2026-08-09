def valid_result:
  try (
    type == "object"
    and (.ruleId | type) == "string"
    and (.ruleId | length) > 0
    and (.message | type) == "object"
    and (.message.text | type) == "string"
    and (.message.text | length) > 0
    and (.locations | type) == "array"
    and (.locations | length) == 1
    and (.locations[0].physicalLocation.artifactLocation.uri | type) == "string"
    and (.locations[0].physicalLocation.artifactLocation.uri | length) > 0
    and (
      (.locations[0].physicalLocation.region.snippet.text | type) as $snippet_type
      | $snippet_type == "null" or $snippet_type == "string"
    )
  ) catch false;

def valid_run:
  try (
    type == "object"
    and .tool.driver.name == "Scorecard"
    and (.tool.driver.semanticVersion | type) == "string"
    and (.tool.driver.semanticVersion | length) > 0
    and (.tool.driver.rules | type) == "array"
    and (.results | type) == "array"
    and all(.results[]; valid_result)
  ) catch false;

def valid_sarif:
  try (
    type == "object"
    and .version == "2.1.0"
    and (.runs | type) == "array"
    and (.runs | length) > 0
    and all(.runs[]; valid_run)
  ) catch false;

def result_uri:
  .locations[0].physicalLocation.artifactLocation.uri;
def result_snippet:
  .locations[0].physicalLocation.region.snippet.text // "";
def result_message:
  .message.text;
def candidate_event:
  $event == "pull_request" or $event == "merge_group";
def trusted_event:
  $event == "push" or $event == "schedule" or $event == "workflow_dispatch";
def token_permission_body($target):
  "topLevel permissions set to 'write-all'\n"
  + "Remediation tip: Visit [https://app.stepsecurity.io/secureworkflow](\($target)).\n"
  + "Tick the 'Restrict permissions for GITHUB_TOKEN'\n"
  + "Untick other options\n"
  + "NOTE: If you want to resolve multiple issues at once, you can visit [https://app.stepsecurity.io/securerepo](https://app.stepsecurity.io/securerepo) instead.\n"
  + "Click Remediation section below for further remediation help";
def accepted_policy_finding:
  (result_uri) as $uri
  | (result_snippet) as $snippet
  | (result_message) as $message
  | if .ruleId == "TokenPermissionsID" then
      ($uri | test("^\\.github/workflows/[^/]+\\.ya?ml$"))
      and $snippet == "write-all"
      and ($message | test("^score is (10|[0-9]): [\\s\\S]+$"))
      and (
        ($uri | sub("^\\.github/workflows/"; "")) as $filename
        | ($message | sub("^score is (10|[0-9]): "; "")) as $body
        | ([
          token_permission_body("https://app.stepsecurity.io/secureworkflow/file://./\($filename)/unknown?enable=permissions"),
          token_permission_body("https://app.stepsecurity.io/secureworkflow/github.com/LCV-Ideas-Software/.github/\($filename)/main?enable=permissions")
        ] | index($body)) != null
      )
    elif .ruleId == "PinnedDependenciesID" then
      ([
        ".github/workflows/cloudflare-pages.yml",
        ".github/workflows/github-slack-integration.yml"
      ] | index($uri)) != null
      and $message == "score is 7: npmCommand not pinned by hash\nClick Remediation section below to solve this issue"
      and ([
        "npm install --prefix \"$wrangler_prefix\" --save-exact --ignore-scripts --no-audit --no-fund wrangler@latest",
        "npm install --prefix \"$wrangler_prefix\" --ignore-scripts --no-audit --no-fund"
      ] | index($snippet)) != null
    elif .ruleId == "BranchProtectionID" then
      $uri == "no file associated with this alert"
      and $snippet == ""
      and (
        (
          candidate_event
          and $message == "score is 3: branch protection is not maximal on development and all release branches:\nWarn: could not determine whether codeowners review is allowed\nWarn: no status checks found to merge onto branch 'main'\nWarn: PRs are not required to make changes on branch 'main'; or we don't have data to detect it.If you think it might be the latter, make sure to run Scorecard with a PAT or use Repo Rules (that are always public) instead of Branch Protection settings\nClick Remediation section below to solve this issue"
        )
        or (
          trusted_event
          and $message == "score is 3: branch protection is not maximal on development and all release branches:\nWarn: 'stale review dismissal' is disabled on branch 'main'\nWarn: branch 'main' does not require approvers\nWarn: codeowners review is not required on branch 'main'\nWarn: 'last push approval' is disabled on branch 'main'\nWarn: 'up-to-date branches' is disabled on branch 'main'\nClick Remediation section below to solve this issue"
        )
      )
    elif .ruleId == "CodeReviewID" then
      trusted_event
      and $uri == "no file associated with this alert"
      and $snippet == ""
      and ($message | test("^score is 0: Found 0/[1-9][0-9]* approved changesets -- score normalized to 0\\nClick Remediation section below to solve this issue$"))
    elif .ruleId == "CIIBestPracticesID" then
      trusted_event
      and $uri == "no file associated with this alert"
      and $snippet == ""
      and $message == "score is 0: no effort to earn an OpenSSF best practices badge detected\nClick Remediation section below to solve this issue"
    else
      false
    end;

if (valid_sarif | not) then
  error("Malformed Scorecard SARIF")
else
  [
    .runs[].results[]
    | select(accepted_policy_finding | not)
    | {
        ruleId: .ruleId,
        path: .locations[0].physicalLocation.artifactLocation.uri
      }
  ] as $unapproved
  | if ($unapproved | length) == 0 then
      true
    else
      error("Unapproved Scorecard findings: \($unapproved | tojson)")
    end
end
