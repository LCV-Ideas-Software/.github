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
def trusted_event:
  $event == "push" or $event == "schedule";
def accepted_policy_finding:
  (result_uri) as $uri
  | (result_snippet) as $snippet
  | (result_message) as $message
  | if .ruleId == "BranchProtectionID" then
      $uri == "no file associated with this alert"
      and $snippet == ""
      and trusted_event
      and $message == "score is 3: branch protection is not maximal on development and all release branches:\nWarn: 'stale review dismissal' is disabled on branch 'main'\nWarn: branch 'main' does not require approvers\nWarn: codeowners review is not required on branch 'main'\nWarn: 'last push approval' is disabled on branch 'main'\nWarn: 'up-to-date branches' is disabled on branch 'main'\nClick Remediation section below to solve this issue"
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
elif (trusted_event | not) then
  error("Unsupported Scorecard event: \($event)")
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
