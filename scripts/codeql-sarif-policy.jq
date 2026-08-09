def valid_result:
  type == "object";

def has_no_external_results:
  (has("externalPropertyFileReferences") | not)
  or .externalPropertyFileReferences == null
  or (
    (.externalPropertyFileReferences | type) == "object"
    and (.externalPropertyFileReferences | has("results") | not)
  );

def valid_run:
  type == "object"
  and (.tool | type) == "object"
  and (.tool.driver | type) == "object"
  and (.tool.driver.name | type) == "string"
  and (.tool.driver.name | length) > 0
  and (
    (has("results") | not)
    or .results == null
    or (
      (.results | type) == "array"
      and all(.results[]; valid_result)
    )
  )
  and has_no_external_results;

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
