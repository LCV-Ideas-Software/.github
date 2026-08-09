def valid_result:
  type == "object";

def has_no_external_properties:
  (has("externalPropertyFileReferences") | not)
  or (
    (.externalPropertyFileReferences | type) == "object"
    and (.externalPropertyFileReferences | length) == 0
  );

def valid_notification:
  type == "object"
  and (
    (has("level") | not)
    or .level == "none"
    or .level == "note"
    or .level == "warning"
  );

def valid_notifications($property):
  (has($property) | not)
  or (
    (.[$property] | type) == "array"
    and all(.[$property][]; valid_notification)
  );

def valid_invocation:
  type == "object"
  and .executionSuccessful == true
  and (has("processStartFailureMessage") | not)
  and valid_notifications("toolExecutionNotifications")
  and valid_notifications("toolConfigurationNotifications");

def valid_invocations:
  (has("invocations") | not)
  or (
    (.invocations | type) == "array"
    and all(.invocations[]; valid_invocation)
  );

def valid_run:
  type == "object"
  and (.tool | type) == "object"
  and (.tool.driver | type) == "object"
  and .tool.driver.name == "CodeQL"
  and (has("conversion") | not)
  and has("results")
  and (.results | type) == "array"
  and all(.results[]; valid_result)
  and has_no_external_properties
  and valid_invocations;

def has_no_inline_external_properties:
  (has("inlineExternalProperties") | not)
  or (
    (.inlineExternalProperties | type) == "array"
    and (.inlineExternalProperties | length) == 0
  );

def valid_sarif_log:
  type == "object"
  and .version == "2.1.0"
  and (.runs | type) == "array"
  and (.runs | length) > 0
  and all(.runs[]; valid_run)
  and has_no_inline_external_properties;

if type != "array" or length != 1 then
  error("CodeQL must produce exactly one document per SARIF file")
elif all(.[]; valid_sarif_log) | not then
  error("CodeQL produced malformed or externally materialized SARIF")
else
  [
    .[]
    | .runs[]
    | (.results // [])[]
    | {
        ruleId: (.ruleId // "unknown"),
        level: (.level // "unknown"),
        path: (.locations[0]?.physicalLocation?.artifactLocation?.uri // "unknown"),
        line: (.locations[0]?.physicalLocation?.region?.startLine // null)
      }
  ]
end
